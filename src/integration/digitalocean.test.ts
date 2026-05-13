// Integration tests against real DigitalOcean.
//
// Skipped unless BOTH env vars are set:
//   RUN_INTEGRATION=1
//   DIGITALOCEAN_TOKEN=<your-token>
//
// Cost estimate: one s-1vcpu-1gb for ~5 minutes plus a 10GB volume → ~$0.02.
// All resources are prefixed `ocd-itest-<random>` so leaks are identifiable
// on the DigitalOcean console.
import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { secretStore } from "../shared/secret-store.ts";

const RUN = process.env.RUN_INTEGRATION === "1" && !!process.env.DIGITALOCEAN_TOKEN;

async function loadProvider() {
  await secretStore.set("digitalocean_api_token", process.env.DIGITALOCEAN_TOKEN!);
  const mod = await import("../shared/providers/digitalocean.ts");
  return mod.digitaloceanCompute;
}

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

const REGION = "nyc3";
const SIZE = "s-1vcpu-1gb";

const TEST_SSH_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIjrX6z6ZtP3pTsg+1KfYQwFgSUfPPQs9UULzGb5p0kP ocd-itest";

const d = RUN ? describe : describe.skip;

d("digitalocean integration (requires RUN_INTEGRATION=1 + DIGITALOCEAN_TOKEN)", () => {
  beforeAll(async () => {
    const tag = randomSuffix();
    const provider = await loadProvider();
    console.log(`[itest] starting DigitalOcean integration suite, tag=${tag}`);

    const sshKeyName = `ocd-itest-${tag}`;
    const sshKey = await provider.ensureSshKey(sshKeyName, TEST_SSH_PUBLIC_KEY);
    const firewallId = await provider.ensureFirewall();
    const netOut = await provider.networks!.ensure();

    const serverName = `ocd-itest-${tag}`;
    const server = await provider.createServer({
      name: serverName,
      serverType: SIZE,
      location: REGION,
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
    console.log(`[itest] provisioned droplet id=${server.providerId} ip=${server.ipv4}`);
  }, 15 * 60_000);

  afterAll(async () => {
    if (!ctx) return;
    const { provider, serverId, sshKeyId, volumeId } = ctx;
    if (volumeId) {
      try { await provider.volumes!.detach(volumeId); } catch (e) { console.warn(`[itest] detach failed: ${e}`); }
      try { await provider.volumes!.delete(volumeId); } catch (e) { console.warn(`[itest] volume delete failed: ${e}`); }
    }
    try { await provider.deleteServer(serverId); } catch (e) { console.warn(`[itest] droplet delete failed: ${e}`); }
    try {
      const { doApi } = await import("../engine/digitalocean/api.ts");
      await doApi(`/account/keys/${sshKeyId}`, { method: "DELETE" });
    } catch (e) { console.warn(`[itest] ssh key delete failed: ${e}`); }
    console.log(`[itest] teardown done for tag=${ctx.tag}`);
  }, 3 * 60_000);

  test("verifyToken accepts the live token", async () => {
    await expect(ctx!.provider.verifyToken(process.env.DIGITALOCEAN_TOKEN!)).resolves.toBeUndefined();
  });

  test("verifyToken rejects an invalid token with a friendly message", async () => {
    await expect(ctx!.provider.verifyToken("bad-token")).rejects.toThrow(/token|401/i);
  });

  test("listServerTypes includes s-1vcpu-1gb and returns sorted-by-memory results", async () => {
    const types = await ctx!.provider.listServerTypes();
    expect(types.length).toBeGreaterThan(3);
    const s = types.find((t) => t.name === SIZE);
    expect(s).toBeDefined();
    expect(s!.cores).toBeGreaterThanOrEqual(1);
    expect(s!.locations).toContain(REGION);
    for (let i = 1; i < types.length; i++) {
      expect(types[i].memory).toBeGreaterThanOrEqual(types[i - 1].memory);
    }
  });

  test("getPricing returns USD pricing for the test size in nyc3", async () => {
    const pricing = await ctx!.provider.getPricing!();
    expect(pricing).not.toBeNull();
    expect(pricing!.currency).toBe("USD");
    const key = `${SIZE}|${REGION}`;
    expect(pricing!.servers[key]).toBeGreaterThan(0);
    expect(pricing!.volumePerGbMonth).toBeGreaterThan(0);
  });

  test("ensureSshKey is idempotent when called with the same key material", async () => {
    const second = await ctx!.provider.ensureSshKey(ctx!.sshKeyName, TEST_SSH_PUBLIC_KEY);
    expect(second.id).toBe(ctx!.sshKeyId);
  });

  test("ensureFirewall returns the same id on repeated calls", async () => {
    const fw = await ctx!.provider.ensureFirewall();
    expect(fw).toBe(ctx!.firewallId);
  });

  test("listServers includes our test droplet with the expected ipv4", async () => {
    const servers = await ctx!.provider.listServers();
    const match = servers.find((s) => s.providerId === ctx!.serverId);
    expect(match).toBeDefined();
    expect(match!.ipv4).toBe(ctx!.serverIp);
  });

  test("getServer reports status=active after waitForRunning", async () => {
    const s = await ctx!.provider.getServer(ctx!.serverId);
    expect(s.providerId).toBe(ctx!.serverId);
    expect(s.status).toBe("active");
    expect(s.ipv4).toBe(ctx!.serverIp);
  });

  test("getServer throws a mapped error for an unknown droplet id", async () => {
    await expect(ctx!.provider.getServer("99999999")).rejects.toThrow();
  });

  test("networks.getPrivateIpv4 returns a private-range address", async () => {
    const ip = await ctx!.provider.networks!.getPrivateIpv4(ctx!.serverId, ctx!.networkId);
    expect(ip).toMatch(/^10\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.168\./);
  });

  test("networks.attachServer is idempotent", async () => {
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
      location: REGION,
    });
    ctx!.volumeId = created.providerId;
    expect(created.providerId.length).toBeGreaterThan(0);
    expect(created.linuxDevice.startsWith("/dev/")).toBe(true);

    let info = await ctx!.provider.volumes!.get(created.providerId);
    expect(info.name).toBe(name);
    expect(info.sizeGb).toBe(10);
    expect(info.location).toBe(REGION);
    expect(info.serverId).toBe(ctx!.serverId);

    const list = await ctx!.provider.volumes!.list();
    expect(list.find((v) => v.providerId === created.providerId)).toBeDefined();

    await ctx!.provider.volumes!.resize(created.providerId, 20);
    info = await ctx!.provider.volumes!.get(created.providerId);
    expect(info.sizeGb).toBe(20);

    await ctx!.provider.volumes!.detach(created.providerId);
    info = await ctx!.provider.volumes!.get(created.providerId);
    expect(info.serverId).toBeNull();

    await ctx!.provider.volumes!.delete(created.providerId);
    ctx!.volumeId = "";
    await expect(ctx!.provider.volumes!.get(created.providerId)).rejects.toThrow();
  }, 3 * 60_000);
});
