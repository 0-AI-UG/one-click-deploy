// Integration tests against real Hetzner Cloud.
//
// Skipped unless BOTH env vars are set:
//   RUN_INTEGRATION=1
//   HCLOUD_TOKEN=<your-token>
//
// Cost estimate: one CX22 for ~5 minutes plus a 10GB volume → ~0.002 EUR.
// All resources are prefixed `ocd-itest-<random>` so leaks are identifiable
// on the Hetzner console.
import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { secretStore } from "../shared/secret-store.ts";

const RUN = process.env.RUN_INTEGRATION === "1" && !!process.env.HCLOUD_TOKEN;

// Dynamic import so the heavy provider module isn't loaded in CI when skipped.
async function loadProvider() {
  await secretStore.set("hetzner_api_token", process.env.HCLOUD_TOKEN!);
  const mod = await import("../shared/providers/hetzner.ts");
  return mod.hetzner;
}

// The suite's shared resources. Populated in beforeAll.
type Ctx = {
  tag: string;
  provider: Awaited<ReturnType<typeof loadProvider>>;
  sshKeyName: string;
  sshKeyId: string;
  firewallId: string;
  networkId: string;
  serverId: string;
  serverIp: string;
  volumeId: string;
};
let ctx: Ctx | null = null;

const LOCATION = "fsn1";
const SERVER_TYPE = "cx23";

// Minimal ed25519 public key for tests — the private half is unused because
// we never SSH in.
const TEST_SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIjrX6z6ZtP3pTsg+1KfYQwFgSUfPPQs9UULzGb5p0kP ocd-itest";

const d = RUN ? describe : describe.skip;

d("hetzner integration (requires RUN_INTEGRATION=1 + HCLOUD_TOKEN)", () => {
  beforeAll(async () => {
    const tag = randomSuffix();
    const provider = await loadProvider();
    console.log(`[itest] starting Hetzner integration suite, tag=${tag}`);

    // 1. SSH key
    const sshKeyName = `ocd-itest-${tag}`;
    const sshKey = await provider.ensureSshKey(sshKeyName, TEST_SSH_PUBLIC_KEY);

    // 2. Firewall (shared project resource — ensureFirewall returns existing).
    const firewallId = await provider.ensureFirewall();

    // 3. Private network (shared).
    const netOut = await provider.networks!.ensure();

    // 4. Server.
    const serverName = `ocd-itest-${tag}`;
    const server = await provider.createServer({
      name: serverName,
      serverType: SERVER_TYPE,
      location: LOCATION,
      sshKeyName: sshKey.name,
      firewallId,
      userData: "#cloud-config\n{}\n",
      networkId: netOut.id,
    });
    await provider.waitForRunning(server.providerId);

    ctx = {
      tag,
      provider,
      sshKeyName: sshKey.name,
      sshKeyId: sshKey.id,
      firewallId,
      networkId: netOut.id,
      serverId: server.providerId,
      serverIp: server.ipv4,
      volumeId: "",
    };
    console.log(`[itest] provisioned server id=${server.providerId} ip=${server.ipv4}`);
  }, 10 * 60_000);

  afterAll(async () => {
    if (!ctx) return;
    const { provider, serverId, sshKeyName, volumeId } = ctx;
    // Detach + delete volume first so it doesn't block server deletion.
    if (volumeId) {
      try { await provider.volumes!.detach(volumeId); } catch (e) { console.warn(`[itest] detach failed: ${e}`); }
      try { await provider.volumes!.delete(volumeId); } catch (e) { console.warn(`[itest] volume delete failed: ${e}`); }
    }
    try { await provider.deleteServer(serverId); } catch (e) { console.warn(`[itest] server delete failed: ${e}`); }
    // Delete the per-suite SSH key (firewall + network are project-shared — leave them).
    try {
      const { hetznerApi } = await import("../engine/hetzner/api.ts");
      const list = await hetznerApi(`/ssh_keys?name=${encodeURIComponent(sshKeyName)}`) as any;
      for (const k of list.ssh_keys ?? []) {
        await hetznerApi(`/ssh_keys/${k.id}`, { method: "DELETE" });
      }
    } catch (e) { console.warn(`[itest] ssh key delete failed: ${e}`); }
    console.log(`[itest] teardown done for tag=${ctx.tag}`);
  }, 3 * 60_000);

  test("verifyToken accepts the live token", async () => {
    await expect(ctx!.provider.verifyToken(process.env.HCLOUD_TOKEN!)).resolves.toBeUndefined();
  });

  test("verifyToken rejects an invalid token with a friendly message", async () => {
    await expect(ctx!.provider.verifyToken("bad-token")).rejects.toThrow(/token|401/i);
  });

  test("listServerTypes includes cx23 and returns sorted-by-memory results", async () => {
    const types = await ctx!.provider.listServerTypes();
    expect(types.length).toBeGreaterThan(3);
    const cx23 = types.find((t) => t.name === "cx23");
    expect(cx23).toBeDefined();
    expect(cx23!.cores).toBeGreaterThanOrEqual(2);
    expect(cx23!.locations).toContain(LOCATION);
    // Sorted ascending by memory.
    for (let i = 1; i < types.length; i++) {
      expect(types[i].memory).toBeGreaterThanOrEqual(types[i - 1].memory);
    }
  });

  test("getPricing returns EUR pricing for cx23 in fsn1", async () => {
    const pricing = await ctx!.provider.getPricing!();
    expect(pricing).not.toBeNull();
    expect(pricing!.currency).toBe("EUR");
    const key = `${SERVER_TYPE}|${LOCATION}`;
    expect(pricing!.servers[key]).toBeGreaterThan(0);
    expect(pricing!.volumePerGbMonth).toBeGreaterThan(0);
  });

  test("ensureSshKey is idempotent when called with the same key material", async () => {
    const second = await ctx!.provider.ensureSshKey(ctx!.sshKeyName, TEST_SSH_PUBLIC_KEY);
    expect(second.id).toBe(ctx!.sshKeyId);
    expect(second.name).toBe(ctx!.sshKeyName);
  });

  test("ensureFirewall returns the same id on repeated calls", async () => {
    const fw = await ctx!.provider.ensureFirewall();
    expect(fw).toBe(ctx!.firewallId);
  });

  test("listServers includes our test server with the expected ipv4", async () => {
    const servers = await ctx!.provider.listServers();
    const match = servers.find((s) => s.providerId === ctx!.serverId);
    expect(match).toBeDefined();
    expect(match!.ipv4).toBe(ctx!.serverIp);
  });

  test("getServer reports status=running after waitForRunning", async () => {
    const s = await ctx!.provider.getServer(ctx!.serverId);
    expect(s.providerId).toBe(ctx!.serverId);
    expect(s.status).toBe("running");
    expect(s.ipv4).toBe(ctx!.serverIp);
  });

  test("getServer throws a mapped error for an unknown server id", async () => {
    await expect(ctx!.provider.getServer("99999999")).rejects.toThrow();
  });

  test("networks.getPrivateIpv4 returns an address in the 10.0.0.0/16 range", async () => {
    const ip = await ctx!.provider.networks!.getPrivateIpv4(ctx!.serverId, ctx!.networkId);
    expect(ip).toMatch(/^10\.\d+\.\d+\.\d+$/);
  });

  test("networks.attachServer is idempotent", async () => {
    // Already attached at create time. Re-attaching should not throw.
    await expect(
      ctx!.provider.networks!.attachServer(ctx!.serverId, ctx!.networkId),
    ).resolves.toBeUndefined();
  });

  test("volume lifecycle: create → attach → get → resize → detach → delete", async () => {
    const name = `ocd-itest-vol-${ctx!.tag}`;
    const created = await ctx!.provider.volumes!.create({
      name,
      sizeGb: 10,
      serverId: ctx!.serverId,
      location: LOCATION,
    });
    ctx!.volumeId = created.providerId;
    expect(created.providerId).toMatch(/^\d+$/);
    expect(created.linuxDevice.startsWith("/dev/")).toBe(true);

    // get should show it attached to our server.
    let info = await ctx!.provider.volumes!.get(created.providerId);
    expect(info.name).toBe(name);
    expect(info.sizeGb).toBe(10);
    expect(info.location).toBe(LOCATION);
    expect(info.serverId).toBe(ctx!.serverId);

    // list() must filter to managed-by-ocd volumes; ours has the label.
    const list = await ctx!.provider.volumes!.list();
    expect(list.find((v) => v.providerId === created.providerId)).toBeDefined();

    // Resize 10 → 20GB (volumes can only grow).
    await ctx!.provider.volumes!.resize(created.providerId, 20);
    info = await ctx!.provider.volumes!.get(created.providerId);
    expect(info.sizeGb).toBe(20);

    // Detach.
    await ctx!.provider.volumes!.detach(created.providerId);
    info = await ctx!.provider.volumes!.get(created.providerId);
    expect(info.serverId).toBeNull();

    // Delete.
    await ctx!.provider.volumes!.delete(created.providerId);
    ctx!.volumeId = ""; // clear so afterAll doesn't retry.
    await expect(ctx!.provider.volumes!.get(created.providerId)).rejects.toThrow();
  }, 2 * 60_000);
});
