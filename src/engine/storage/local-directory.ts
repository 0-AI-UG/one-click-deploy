import * as db from "../../shared/db.ts";
import type { ServerRow } from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import type { StorageDriver, StorageVolume } from "./contracts.ts";

const ROOT = "/var/lib/ocd/volumes";
const ID = /^local:(\d+):([a-z0-9][a-z0-9-]{0,127})$/;

function parse(volumeId: string): { serverId: number; name: string; hostPath: string } {
  const match = ID.exec(volumeId);
  if (!match) throw new Error(`Invalid local-directory volume id: ${volumeId}`);
  return { serverId: Number(match[1]), name: match[2], hostPath: `${ROOT}/${match[2]}` };
}

function connection(server: ServerRow) {
  return {
    address: server.management_address || server.ipv4,
    hostKey: server.ssh_host_key || undefined,
    options: { user: server.ssh_user || "root", port: server.ssh_port || 22 },
  };
}

async function exec(server: ServerRow, command: string): Promise<string> {
  const c = connection(server);
  const result = await sshExec(c.address, command, c.hostKey, c.options);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Remote storage command failed");
  return result.stdout.trim();
}

export const localDirectoryStorage: StorageDriver = {
  id: "local-directory",
  name: "Server-local directory",
  portable: false,
  supports: () => true,

  async create({ server, name, sizeGb }) {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) throw new Error(`Invalid local volume name: ${name}`);
    const id = `local:${server.id}:${name}`;
    const { hostPath } = parse(id);
    await exec(server, `install -d -m 0750 -- ${JSON.stringify(hostPath)}`);
    return { id, name, sizeGb, location: `server:${server.id}`, attachedServerId: String(server.id), hostPath };
  },

  async inspect(volumeId, server) {
    const parsed = parse(volumeId);
    const resolved = server ?? db.getServer(parsed.serverId) ?? undefined;
    if (!resolved || resolved.id !== parsed.serverId) throw new Error(`Local volume ${volumeId} belongs to server ${parsed.serverId}`);
    await exec(resolved, `test -d ${JSON.stringify(parsed.hostPath)}`);
    return {
      id: volumeId,
      name: parsed.name,
      sizeGb: 0,
      location: `server:${resolved.id}`,
      attachedServerId: String(resolved.id),
      hostPath: parsed.hostPath,
    };
  },

  async list() {
    // Local volumes are inventoried from OCD's database because every server
    // has an independent filesystem and there is no provider control plane.
    return [];
  },

  async attach(volumeId, server) {
    await this.inspect(volumeId, server);
  },
  async detach(volumeId, server) {
    if (server) await this.inspect(volumeId, server);
  },
  async resize(volumeId, _sizeGb, server) {
    if (server) await this.inspect(volumeId, server);
  },
  async rename() {
    throw new Error("Server-local volumes cannot be renamed");
  },
  async delete(volumeId, server) {
    const parsed = parse(volumeId);
    const resolved = server ?? db.getServer(parsed.serverId) ?? undefined;
    if (!resolved || resolved.id !== parsed.serverId) throw new Error(`Local volume ${volumeId} belongs to server ${parsed.serverId}`);
    await exec(resolved, `rm -rf -- ${JSON.stringify(parsed.hostPath)}`);
  },
  async ensureMount({ server, volumeId }) {
    await this.inspect(volumeId, server);
  },
  async removeMount({ server, volumeId }) {
    // The directory is the durable volume itself. Removing an app mount must
    // never remove or unmount its retained data.
    await this.inspect(volumeId, server);
  },
};
