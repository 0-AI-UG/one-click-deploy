import type { OperationRow } from "../shared/db/operations.ts";

export type OpContext<Input = unknown> = {
  opId: number;
  kind: string;
  input: Input;
  orgId: string;
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
};

export type OpKindDefinition<Input = unknown> = {
  kind: string;
  label: string;
  resourceKeys: (input: Input) => string[];
  // Out is invariant on Step (appears in both run's return and compensate's
  // input), so we use `any` here to hold heterogeneous steps in one array.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<Input, any>[];
};

// Heterogeneous registry entry. Individual ops are parameterised by their own
// Input shape, but the registry and step runner dispatch by kind and need a
// single container type. Input appears in both covariant (step.run's ctx) and
// contravariant (resourceKeys) positions, so no sound narrow type works; this
// is the canonical place where `any` is correct.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOpKind = OpKindDefinition<any>;

export type Operation = OperationRow;
