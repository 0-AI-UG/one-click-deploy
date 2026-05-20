import type { OperationRow } from "../shared/db/operations.ts";

export type OpContext<Input = unknown> = {
  opId: number;
  kind: string;
  input: Input;
  trigger: string;
  triggeredBy: string;
  parentId: number | null;
  attempt: number;
  isCancelRequested: () => boolean;
  log: (line: string) => void;
  // Voluntarily release the engine concurrency slot while awaiting external
  // work (e.g. child ops). The promise keeps running; only the budget changes.
  // Must be paired with unpark() before the step returns.
  park: () => void;
  unpark: () => void;
};

export type Step<Input = unknown, Out = unknown> = {
  name: string;
  label?: string;
  run: (ctx: OpContext<Input>, prior: Record<string, unknown>) => Promise<Out>;
  compensate?: (ctx: OpContext<Input>, out: Out, prior: Record<string, unknown>) => Promise<void>;
  /**
   * Idempotency check. If the side effect from `run` already exists in the
   * world (detected via tags/labels/listing), return its output; the runner
   * will adopt it and skip `run`. Critical for safe resume after a crash that
   * happened between starting and finishing `run`.
   * Returning null means "no existing side effect found, please run".
   */
  probe?: (ctx: OpContext<Input>, prior: Record<string, unknown>) => Promise<Out | null>;
  /**
   * Mirror of `probe` for compensation: return true if the side effect is
   * already gone (so the compensate body can be skipped during resume).
   */
  probeCompensated?: (ctx: OpContext<Input>, out: Out, prior: Record<string, unknown>) => Promise<boolean>;
};

export type OpKindDefinition<Input = unknown> = {
  kind: string;
  label: string;
  resourceKeys: (input: Input) => string[];
  steps: Step<Input, any>[];
};

export type AnyOpKind = OpKindDefinition<any>;

export type Operation = OperationRow;
