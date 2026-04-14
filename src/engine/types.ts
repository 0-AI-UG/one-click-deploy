import type { OperationRow } from "../bun/db/operations.ts";

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
  steps: Step<Input, any>[];
};

export type AnyOpKind = OpKindDefinition<any>;

export type Operation = OperationRow;
