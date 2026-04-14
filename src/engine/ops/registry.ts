import type { AnyOpKind } from "../types.ts";

const registry = new Map<string, AnyOpKind>();

export function registerOp(def: AnyOpKind): void {
  if (registry.has(def.kind)) {
    throw new Error(`Engine op kind already registered: ${def.kind}`);
  }
  registry.set(def.kind, def);
}

export function getOp(kind: string): AnyOpKind | null {
  return registry.get(kind) ?? null;
}

export function listOps(): AnyOpKind[] {
  return Array.from(registry.values());
}

export function stepCount(kind: string): number {
  return registry.get(kind)?.steps.length ?? 0;
}
