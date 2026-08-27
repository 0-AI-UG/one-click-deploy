import { CopyButton } from "./ui.tsx";
import type { DnsInstruction } from "../types.ts";

const statusClass: Record<DnsInstruction["status"], string> = {
  correct: "bg-green-200",
  pending: "bg-yellow-200",
  conflicting: "bg-red-200",
  not_applicable: "bg-alt",
};

export function DnsInstructionView({ value }: { value?: DnsInstruction | null }) {
  if (!value) return null;
  return (
    <div className="border-2 border-fg bg-bg p-3 space-y-2 font-mono text-[10px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-bold uppercase tracking-wider">DNS instruction</span>
        <span className={`border border-fg px-1.5 py-0.5 text-[8px] font-bold uppercase ${statusClass[value.status]}`}>
          {value.status.replace("_", " ")}
        </span>
      </div>
      {value.record ? (
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 gap-y-1 items-center">
          <span className="text-muted">Type</span>
          <code className="text-fg">{value.record.type}</code>
          <CopyButton text={value.record.type} />
          <span className="text-muted">Name</span>
          <code className="text-fg break-all">{value.record.name}</code>
          <CopyButton text={value.record.name} />
          <span className="text-muted">Value</span>
          <code className="text-fg break-all">{value.record.value}</code>
          <CopyButton text={value.record.value} />
        </div>
      ) : null}
      <p className="text-muted leading-relaxed">{value.message}</p>
      {value.observedValues.length > 0 && value.status !== "correct" ? (
        <p className="text-accent-red">Observed: {value.observedValues.join(", ")}</p>
      ) : null}
    </div>
  );
}
