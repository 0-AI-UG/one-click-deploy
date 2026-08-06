// Shared helpers for bun:test tests. The temp data dir is established by
// src/shared/test-preload.ts (bunfig.toml preload) before any import runs.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { mock } from "bun:test";
import type { Hetzner, HetznerDns } from "./providers/hetzner.ts";
import type { OperationRow } from "./db/operations.ts";

/** Return the test run's temp data dir. Setting OCD_DATA_DIR here would be
 *  too late — import hoisting evaluates paths.ts/db before any test-file
 *  statement — so the real work happens in test-preload.ts; this exists as
 *  the conventional marker in test files and for dir inspection. */
export function useTempDataDir(): string {
  if (!process.env.OCD_DATA_DIR) {
    // Only reachable when a test runs without the bunfig preload (e.g. a
    // bare `bun run` of a test file) — best effort, may be too late for db.
    process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-test-"));
  }
  return process.env.OCD_DATA_DIR;
}

export function randomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Route suites that stub out `requirePermission` still need the stubbed
 *  userId to resolve to a real admin row, because handlers now also call
 *  `hasPermission` directly to filter what a caller may see (stack member logs,
 *  for one). Seeding this once keeps those handlers on their admin fast path. */
export const TEST_ADMIN_ID = "test-admin";

export function seedTestAdmin(): string {
  const { getUserById, insertUser } = require("./db/users.ts");
  if (!getUserById(TEST_ADMIN_ID)) {
    insertUser({ id: TEST_ADMIN_ID, username: "test-admin", password_hash: "x", is_admin: true });
  }
  return TEST_ADMIN_ID;
}

/** Factory for a fully-stubbed ComputeProvider. Every method is a bun mock
 *  so callers can assert calls and override return values per-test. */
export function makeFakeComputeProvider(
  overrides: Partial<Hetzner> = {},
): Hetzner & {
  // surface the mocks for assertion
  _mocks: {
    deleteServer: ReturnType<typeof mock>;
    createServer: ReturnType<typeof mock>;
    getServer: ReturnType<typeof mock>;
    ensureSshKey: ReturnType<typeof mock>;
    ensureFirewall: ReturnType<typeof mock>;
    ensureFirewallAttached: ReturnType<typeof mock>;
    volumeCreate: ReturnType<typeof mock>;
    volumeDelete: ReturnType<typeof mock>;
    volumeAttach: ReturnType<typeof mock>;
    volumeDetach: ReturnType<typeof mock>;
    volumeRename: ReturnType<typeof mock>;
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
    ensureFirewallAttached: mock(async () => {}),
    volumeCreate: mock(async (opts: { name: string; sizeGb: number }) => ({
      providerId: `v-${opts.name}`,
      linuxDevice: "/dev/sdb",
    })),
    volumeDelete: mock(async (_id: string) => {}),
    volumeAttach: mock(async () => {}),
    volumeDetach: mock(async () => {}),
    volumeRename: mock(async () => {}),
  };
  const provider: Hetzner = {
    id: "hetzner",
    name: "Hetzner",
    tokenKey: "hetzner_api_token",
    validateToken: () => ({ valid: true, value: "x".repeat(40) }),
    verifyToken: async () => {},
    ensureSshKey: _mocks.ensureSshKey,
    ensureFirewall: _mocks.ensureFirewall,
    ensureFirewallAttached: _mocks.ensureFirewallAttached,
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
      rename: _mocks.volumeRename,
      delete: _mocks.volumeDelete,
    },
    networks: {
      ensure: async () => ({ id: "net-1" }),
      attachServer: async () => {},
      getPrivateIpv4: async () => "10.0.0.2",
    },
    getPricing: async () => null,
    ...overrides,
  };
  return Object.assign(provider, { _mocks }) as any;
}

export type EnqueueAndWaitOpts = {
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
 */
export async function enqueueAndWait(
  kind: string,
  input: unknown,
  opts: EnqueueAndWaitOpts = {},
): Promise<EnqueueAndWaitResult> {
  const { enqueueOperation, getOperation } = await import("./db/operations.ts");
  const row = enqueueOperation({
    kind,
    resourceKeys: [],
    input,
    trigger: "test-helper",
  });
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const deadline = Date.now() + timeout;
  const terminal = ["done", "failed", "cancelled", "compensated"] as const;
  while (Date.now() < deadline) {
    const op = getOperation(row.id) as OperationRow | null;
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
 */
export async function waitForReplicaHealthy(
  replicaId: number,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const { getReplica } = await import("./db/replicas.ts");
  const timeout = opts.timeoutMs ?? 2 * 60_000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = getReplica(replicaId);
    if (r?.status === "running") return;
    await Bun.sleep(500);
  }
  throw new Error(
    `waitForReplicaHealthy: replica ${replicaId} did not become healthy within ${timeout}ms`,
  );
}

export function makeFakeDnsProvider(
  overrides: Partial<HetznerDns> = {},
): HetznerDns & {
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
  const provider: HetznerDns = {
    id: "hetzner-dns",
    name: "Hetzner DNS",
    listZones: async () => [{ id: "zone-1", name: "example.com" }],
    createRecord: _mocks.createRecord,
    deleteRecord: _mocks.deleteRecord,
    ...overrides,
  };
  return Object.assign(provider, { _mocks }) as any;
}
