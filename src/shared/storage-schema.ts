import { z } from "zod";
export const StorageBindingsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.object({
  connection: z.string().min(1).optional(),
  bucket: z.string().refine(v => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v) && !v.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(v), "Invalid bucket"),
  prefix: z.string().max(500).refine(v => !v || (v.endsWith("/") && !v.startsWith("/") && !v.includes("\\") && !v.split("/").some(p => p === "." || p === "..") && !/[\x00-\x1f\x7f]/.test(v)), "Use a relative prefix ending in /"),
  permissions: z.array(z.enum(["read", "write", "delete", "list"])).min(1),
  /** Change to explicitly rotate a token without changing its access. */
  generation: z.number().int().min(0).optional(),
}).strict());
export type StorageBindings = z.infer<typeof StorageBindingsSchema>;
