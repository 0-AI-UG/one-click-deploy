// Unit tests for host-mounts.ts — bind-mount + fstab management for Hetzner
// volumes. We inject a simulated ssh executor via the module's resettable seam
// (__setSshExecForTest) so the tests inspect the exact commands that would run
// on the server, plus a tiny in-memory "remote shell" model that lets us assert
// fstab idempotency. Using the seam (not mock.module) keeps this file from
// leaking a process-global ssh mock into other test files.
import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// Simulated remote-server state.
type RemoteState = {
  // What `findmnt -no SOURCE <path>` reports per-path. Empty string = not mounted.
  findmnt: Map<string, string>;
  // The current /etc/fstab content (line-oriented).
  fstab: string[];
  // Captured commands (in order) for assertion.
  commands: string[];
};

let state: RemoteState;

function freshState(): RemoteState {
  return { findmnt: new Map(), fstab: [], commands: [] };
}

// Mock sshExec to pattern-match the small set of commands ensureVolumeBindMount /
// removeVolumeBindMount / bindMountStatus emit, and update the simulated state
// accordingly.
async function defaultSshExec(_ip: string, command: string, _hostKey?: string) {
  state.commands.push(command);

  // findmnt: `findmnt -no SOURCE <path>` (optionally `2>/dev/null || true`)
  const findmntMatch = command.match(/^findmnt -no SOURCE (\S+)/);
  if (findmntMatch) {
    const path = findmntMatch[1];
    const src = state.findmnt.get(path) || "";
    return { stdout: src + (src ? "\n" : ""), stderr: "", exitCode: 0 };
  }

  // mkdir -p <path> && chown ...
  if (/^mkdir -p \S+/.test(command)) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // mount --bind <src> <dst>
  const bindMatch = command.match(/^mount --bind (\S+) (\S+)$/);
  if (bindMatch) {
    state.findmnt.set(bindMatch[2], bindMatch[1]);
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // Grep probe (status helper) — match BEFORE the generic fstab branch
  // since both contain "/etc/fstab".
  if (command.includes("grep -q") && command.includes("ocd-bind") && command.includes("/etc/fstab")) {
    const present = state.fstab.some((l) => l.startsWith("# BEGIN ocd-bind"));
    return { stdout: present ? "yes\n" : "no\n", stderr: "", exitCode: 0 };
  }

  // Compound fstab update: `sed -i '...' /etc/fstab && printf ... >> /etc/fstab`
  if (command.includes("/etc/fstab")) {
    const sedMatch = command.match(/sed -i '(.+?)' \/etc\/fstab/);
    if (sedMatch) {
      const expr = sedMatch[1];
      // Expect "/<begin>/,/<end>/d" with `[/]` escaped to `\/`.
      const m = expr.match(/^\/(.+?)\/,\/(.+?)\/d$/);
      if (m) {
        const begin = m[1].replace(/\\\//g, "/");
        const end = m[2].replace(/\\\//g, "/");
        const inBlock = (line: string) => line === begin;
        const next: string[] = [];
        let skipping = false;
        for (const line of state.fstab) {
          if (!skipping && inBlock(line)) { skipping = true; continue; }
          if (skipping && line === end) { skipping = false; continue; }
          if (!skipping) next.push(line);
        }
        state.fstab = next;
      }
    }
    // printf '%s\n%s\n%s\n' "BEGIN" "LINE" "END" >> /etc/fstab
    const printfMatch = command.match(/printf '%s\\n%s\\n%s\\n' (".+?") (".+?") (".+?") >> \/etc\/fstab/);
    if (printfMatch) {
      const dec = (s: string) => JSON.parse(s);
      state.fstab.push(dec(printfMatch[1]), dec(printfMatch[2]), dec(printfMatch[3]));
    }
    // Bare `sed -i ... /etc/fstab` (removeVolumeBindMount path)
    // already handled above.
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  if (command.startsWith("systemctl daemon-reload")) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // umount / rmdir
  const umountMatch = command.match(/^umount(?: -l)? (\S+)/);
  if (umountMatch) {
    const path = umountMatch[1];
    state.findmnt.delete(path);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  if (/^rmdir \S+/.test(command)) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // Default: ok
  return { stdout: "", stderr: "", exitCode: 0 };
}

import {
  ensureVolumeBindMount,
  removeVolumeBindMount,
  bindMountStatus,
  buildFstabBlock,
  __setSshExecForTest,
  __resetSshExecForTest,
} from "./host-mounts.ts";

beforeEach(() => {
  state = freshState();
  __setSshExecForTest(defaultSshExec);
});

afterEach(() => __resetSshExecForTest());

describe("buildFstabBlock", () => {
  test("formats the documented block exactly", () => {
    const block = buildFstabBlock({
      blockName: "app-42",
      hetznerVolumeId: 105430926,
      hostMountPath: "/mnt/ocd-myapp-data",
    });
    expect(block).toBe(
      "# BEGIN ocd-bind app-42\n" +
      "/mnt/HC_Volume_105430926  /mnt/ocd-myapp-data  none  bind,nofail,x-systemd.requires=/mnt/HC_Volume_105430926  0 0\n" +
      "# END ocd-bind app-42",
    );
  });
});

describe("ensureVolumeBindMount", () => {
  test("throws when the Hetzner volume isn't mounted", async () => {
    // No entry for /mnt/HC_Volume_999 → simulated findmnt returns empty.
    // mountWaitMs: 0 → probe once, then give up immediately (no polling wait).
    await expect(
      ensureVolumeBindMount({
        serverIp: "1.2.3.4",
        hetznerVolumeId: 999,
        hostMountPath: "/mnt/ocd-x-data",
        blockName: "app-1",
        mountWaitMs: 0,
      }),
    ).rejects.toThrow(/Hetzner volume not mounted/);
  });

  test("retries and succeeds once the volume mounts mid-poll", async () => {
    // Volume not mounted on the first probe, then appears — the poll loop
    // should recover instead of failing on the race like it used to.
    let probes = 0;
    __setSshExecForTest(async (ip: string, command: string, key?: string) => {
      const m = command.match(/^findmnt -no SOURCE (\/mnt\/HC_Volume_\S+)/);
      if (m) {
        probes++;
        // Only mount it on the 2nd+ probe of the HC volume path.
        if (probes >= 2) state.findmnt.set(m[1], "/dev/sdb");
      }
      return defaultSshExec(ip, command, key);
    });
    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-1",
      mountWaitMs: 5_000,
      mountPollMs: 10,
    });
    expect(state.findmnt.get("/mnt/ocd-x-data")).toBe("/mnt/HC_Volume_42");
    expect(probes).toBeGreaterThanOrEqual(2);
  });

  test("mounts and writes a tagged fstab block", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");

    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });

    // bind happened
    expect(state.findmnt.get("/mnt/ocd-x-data")).toBe("/mnt/HC_Volume_42");
    // fstab has exactly one tagged block
    expect(state.fstab).toEqual([
      "# BEGIN ocd-bind app-7",
      "/mnt/HC_Volume_42  /mnt/ocd-x-data  none  bind,nofail,x-systemd.requires=/mnt/HC_Volume_42  0 0",
      "# END ocd-bind app-7",
    ]);
  });

  test("refuses to hide legacy root-disk data behind an attached volume", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");
    __setSshExecForTest(async (ip: string, command: string, key?: string) => {
      if (command.startsWith("find /mnt/ocd-x-data ")) {
        return { stdout: "/mnt/ocd-x-data/deploy.db\n", stderr: "", exitCode: 0 };
      }
      return defaultSshExec(ip, command, key);
    });

    await expect(
      ensureVolumeBindMount({
        serverIp: "1.2.3.4",
        hetznerVolumeId: 42,
        hostMountPath: "/mnt/ocd-x-data",
        blockName: "panel",
      }),
    ).rejects.toThrow(/Legacy data migration required/);

    expect(state.commands.some((command) => command.startsWith("mount --bind"))).toBe(false);
    expect(state.fstab).toEqual([]);
  });

  test("refuses to stack over an unrelated mounted filesystem", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");
    state.findmnt.set("/mnt/ocd-x-data", "/dev/sdc");

    await expect(
      ensureVolumeBindMount({
        serverIp: "1.2.3.4",
        hetznerVolumeId: 42,
        hostMountPath: "/mnt/ocd-x-data",
        blockName: "app-7",
      }),
    ).rejects.toThrow(/already mounted from \/dev\/sdc/);
  });

  test("is idempotent — running twice yields identical fstab and a single bind", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");

    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });
    const fstabAfterFirst = [...state.fstab];

    // Second invocation: state already has the bind in place.
    const bindCmdsBefore = state.commands.filter((c) => c.startsWith("mount --bind")).length;
    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });
    const bindCmdsAfter = state.commands.filter((c) => c.startsWith("mount --bind")).length;

    expect(state.fstab).toEqual(fstabAfterFirst);
    expect(bindCmdsAfter).toBe(bindCmdsBefore); // no extra `mount --bind`
  });
});

describe("removeVolumeBindMount", () => {
  test("clears the bind and removes the fstab block", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");
    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });
    expect(state.fstab.length).toBe(3);

    await removeVolumeBindMount({
      serverIp: "1.2.3.4",
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });

    // Bind gone, fstab clean of orphan markers.
    expect(state.findmnt.get("/mnt/ocd-x-data")).toBeUndefined();
    expect(state.fstab.filter((l) => l.includes("ocd-bind"))).toEqual([]);
  });

  test("never throws when nothing is mounted", async () => {
    // No prior ensure — state is empty.
    await removeVolumeBindMount({
      serverIp: "1.2.3.4",
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });
    // Just checking it resolved.
    expect(true).toBe(true);
  });
});

describe("bindMountStatus", () => {
  test("absent: no mount, no fstab", async () => {
    const s = await bindMountStatus({ serverIp: "1.2.3.4", hostMountPath: "/mnt/ocd-x-data" });
    expect(s).toEqual({ mounted: false, sourceDevice: null, fstabPresent: false, matchesExpectedVolume: null });
  });

  test("mounted + fstab present", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");
    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });
    const s = await bindMountStatus({ serverIp: "1.2.3.4", hostMountPath: "/mnt/ocd-x-data" });
    expect(s.mounted).toBe(true);
    expect(s.sourceDevice).toBe("/mnt/HC_Volume_42");
    expect(s.fstabPresent).toBe(true);
    expect(s.matchesExpectedVolume).toBeNull();
  });

  test("matches a bind by resolved block-device source", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");
    state.findmnt.set("/mnt/ocd-x-data", "/dev/sdb");
    state.fstab.push(
      "# BEGIN ocd-bind panel",
      "/mnt/HC_Volume_42 /mnt/ocd-x-data none bind 0 0",
      "# END ocd-bind panel",
    );

    const s = await bindMountStatus({
      serverIp: "1.2.3.4",
      hostMountPath: "/mnt/ocd-x-data",
      expectedVolumeId: 42,
      blockName: "panel",
    });
    expect(s.matchesExpectedVolume).toBe(true);
    expect(s.fstabPresent).toBe(true);
  });

  test("dangling: fstab present but nothing mounted", async () => {
    state.findmnt.set("/mnt/HC_Volume_42", "/dev/sdb");
    await ensureVolumeBindMount({
      serverIp: "1.2.3.4",
      hetznerVolumeId: 42,
      hostMountPath: "/mnt/ocd-x-data",
      blockName: "app-7",
    });
    // Simulate a reboot scenario: bind has gone away but fstab still says
    // it should exist.
    state.findmnt.delete("/mnt/ocd-x-data");

    const s = await bindMountStatus({ serverIp: "1.2.3.4", hostMountPath: "/mnt/ocd-x-data" });
    expect(s.mounted).toBe(false);
    expect(s.sourceDevice).toBeNull();
    expect(s.fstabPresent).toBe(true);
  });
});
