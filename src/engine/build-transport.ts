import type { ServerRow } from "../shared/db/servers.ts";
import {
  buildCommitOnWorker,
  probeBuildWorker,
  verifyBuildArtifact,
  type BuildTarget,
} from "./build-worker.ts";

export type WorkerObservation = {
  online: boolean;
  version: string;
  architecture: string;
  diskFreeBytes: number;
  error: string;
};

export type BuildCommitInput = {
  server: ServerRow;
  operationId: number;
  repository: string;
  commit: string;
  targets?: BuildTarget[];
  resolveTargets?: (readFile: (path: string) => Promise<string>) => Promise<BuildTarget[]>;
  readFiles?: string[];
  gitUsername?: string;
  gitToken?: string;
  registryUsername?: string;
  registryPassword?: string;
  resolveRegistryCredentials?: (image: string) => Promise<{ username?: string; password?: string }>;
  onArtifact?: (name: string, image: string) => Promise<void> | void;
  onLog?: (line: string) => void;
};

export type VerifyArtifactInput = {
  server: ServerRow;
  image: string;
  registryUsername?: string;
  registryPassword?: string;
};

export type BuildCommitResult = {
  refs: Map<string, string>;
  files: Record<string, string>;
};

/**
 * Boundary between durable build-delivery operations and remote execution.
 * Production uses SSH-backed workers; tests can supply an in-memory transport
 * without replacing process-global modules.
 */
export type BuildTransport = {
  probeWorker: (server: ServerRow) => Promise<WorkerObservation>;
  buildCommit: (input: BuildCommitInput) => Promise<BuildCommitResult>;
  verifyArtifact: (input: VerifyArtifactInput) => Promise<boolean>;
};

export const sshBuildTransport: BuildTransport = {
  probeWorker: probeBuildWorker,
  buildCommit: buildCommitOnWorker,
  verifyArtifact: verifyBuildArtifact,
};
