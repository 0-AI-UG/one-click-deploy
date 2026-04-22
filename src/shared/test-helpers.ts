// Shared helpers for bun:test tests. Callers must set OCD_DATA_DIR before
// importing db.ts; see existing *.test.ts files for the pattern.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { mock } from "bun:test";
import type { ComputeProvider, DnsProvider } from "./providers/types.ts";
import type { OperationRow } from "./db/operations.ts";

/** Create a fresh temp data dir and set OCD_DATA_DIR to it. Must run before
 *  any db.ts import. Returns the path so tests can inspect/cleanup. */
export function useTempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-test-"));
  process.env.OCD_DATA_DIR = dir;
  return dir;
}

export function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Factory for a fully-stubbed ComputeProvider. Every method is a bun mock
 *  so callers can assert calls and override return values per-test. */
export function makeFakeComputeProvider(
  overrides: Partial<ComputeProvider> = {},
): ComputeProvider & {
  // surface the mocks for assertion
  _mocks: {
    deleteServer: ReturnType<typeof mock>;
    createServer: ReturnType<typeof mock>;
    getServer: ReturnType<typeof mock>;
    ensureSshKey: ReturnType<typeof mock>;
    ensureFirewall: ReturnType<typeof mock>;
    volumeCreate: ReturnType<typeof mock>;
    volumeDelete: ReturnType<typeof mock>;
    volumeAttach: ReturnType<typeof mock>;
    volumeDetach: ReturnType<typeof mock>;
  };
} {
  const _mocks = {
    deleteServer: mock(async (_id: string) => {}),
    createServer: mock(async (opts: { name: string }) => ({
      providerId: `h-${opts.name}-${Math.random()}`,
      ipv4: "10.0.0.1",
      ipv6: "",
      privateIpv4: "",
      status: "running",
    })),
    getServer: mock(async (id: string) => ({
      providerId: id,
      ipv4: "10.0.0.1",
      ipv6: "",
      status: "running",
    })),
    ensureSshKey: mock(async (name: string) => ({ id: "k1", name })),
    ensureFirewall: mock(async () => "fw-1"),
    volumeCreate: mock(async (opts: { name: string; sizeGb: number }) => ({
      providerId: `v-${opts.name}`,
      linuxDevice: "/dev/sdb",
    })),
    volumeDelete: mock(async (_id: string) => {}),
    volumeAttach: mock(async () => {}),
    volumeDetach: mock(async () => {}),
  };
  const provider: ComputeProvider = {
    id: "hetzner",
    name: "Hetzner",
    tokenKey: "hetzner_api_token",
    validateToken: () => ({ valid: true, value: "x".repeat(40) }),
    verifyToken: async () => {},
    ensureSshKey: _mocks.ensureSshKey,
    ensureFirewall: _mocks.ensureFirewall,
    listServerTypes: async () => [],
    createServer: _mocks.createServer,
    getServer: _mocks.getServer,
    waitForRunning: async () => {},
    deleteServer: _mocks.deleteServer,
    listServers: async () => [],
    volumes: {
      create: _mocks.volumeCreate,
      get: async (id) => ({
        providerId: id,
        name: "v",
        sizeGb: 10,
        location: "fsn1",
        serverId: null,
      }),
      list: async () => [],
      attach: _mocks.volumeAttach,
      detach: _mocks.volumeDetach,
      resize: async () => {},
      delete: _mocks.volumeDelete,
    },
    ...overrides,
  };
  return Object.assign(provider, { _mocks });
}

export function makeFakeDnsProvider(
  overrides: Partial<DnsProvider> = {},
): DnsProvider & {
  _mocks: { createRecord: ReturnType<typeof mock>; deleteRecord: ReturnType<typeof mock> };
} {
  const _mocks = {
    createRecord: mock(
      async (opts: { zoneId: string; name: string; type: string; value: string }) => ({
        id: `rec-${opts.name}`,
        name: opts.name,
        type: opts.type,
        value: opts.value,
      }),
    ),
    deleteRecord: mock(async () => {}),
  };
  const provider: DnsProvider = {
    id: "hetzner-dns",
    name: "Hetzner DNS",
    listZones: async () => [{ id: "zone-1", name: "example.com" }],
    createRecord: _mocks.createRecord,
    deleteRecord: _mocks.deleteRecord,
    ...overrides,
  };
  return Object.assign(provider, { _mocks });
}

export type EnqueueAndWaitOpts = {
  /** Override org_id on the enqueued operation (default: ""). */
  orgId?: string;
  /** How long to poll before throwing (default: 5 minutes). */
  timeoutMs?: number;
};

export type EnqueueAndWaitResult = {
  status: string;
  error?: string;
  /** The database row id of the created operation. */
  opId: number;
};

/**
 * Enqueue an operation and poll the `operations` table until it reaches a
 * terminal status (`done`, `failed`, `cancelled`, `compensated`).
 *
 * Suitable for both Layer-1 (temp-SQLite, fake providers) and Layer-2
 * (real Hetzner) tests.
 *
 * @example
 *   const { status } = await enqueueAndWait("fast-noop", {}, { timeoutMs: 2000 });
 *   expect(status).toBe("done");
 */
export async function enqueueAndWait(
  kind: string,
  input: unknown,
  opts: EnqueueAndWaitOpts = {},
): Promise<EnqueueAndWaitResult> {
  const { enqueueOperation, getOperationUnscoped } = await import("./db/operations.ts");
  const row = enqueueOperation({
    kind,
    resourceKeys: [],
    input,
    trigger: "test-helper",
    orgId: opts.orgId ?? "",
  });
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const deadline = Date.now() + timeout;
  const terminal = ["done", "failed", "cancelled", "compensated"] as const;
  while (Date.now() < deadline) {
    const op = getOperationUnscoped(row.id) as OperationRow | null;
    if (!op) throw new Error(`enqueueAndWait: op ${row.id} disappeared`);
    if ((terminal as readonly string[]).includes(op.status)) {
      const error = op.error_json
        ? (JSON.parse(op.error_json) as { message?: string })?.message
        : undefined;
      return { status: op.status, error, opId: op.id };
    }
    await Bun.sleep(200);
  }
  throw new Error(`enqueueAndWait: op ${row.id} (${kind}) timed out after ${timeout}ms`);
}

/**
 * Poll the `replicas` table until the given replica has `status = 'running'`.
 *
 * Useful in Layer-2 tests that wait for a container to come up after a deploy
 * or restart.
 */
export async function waitForReplicaHealthy(
  replicaId: number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const { getReplicaUnscoped } = await import("./db/replicas.ts");
  const timeout = opts.timeoutMs ?? 2 * 60_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = getReplicaUnscoped(replicaId);
    if (r?.status === "running") return;
    await Bun.sleep(500);
  }
  throw new Error(`waitForReplicaHealthy: replica ${replicaId} did not become healthy within ${timeout}ms`);
}
