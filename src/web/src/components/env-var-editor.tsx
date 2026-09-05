import { Lock, Unlock, Plus, Minus } from "lucide-react";
import { Btn } from "./ui.tsx";

export type EnvVarRow = {
  key: string;
  value: string;
  secret: boolean;
  injected_by?: string;
};

type Props = {
  entries: EnvVarRow[];
  onChange: (entries: EnvVarRow[]) => void;
  readOnly?: boolean;
  label?: string;
};

export function EnvVarEditor({ entries, onChange, readOnly, label }: Props) {
  const update = (i: number, field: keyof EnvVarRow, val: string | boolean) => {
    const next = [...entries];
    next[i] = { ...next[i], [field]: val };
    onChange(next);
  };

  return (
    <div>
      {label && (
        <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-2">{label}</div>
      )}
      {entries.length === 0 && !readOnly && (
        <p className="text-[10px] text-muted font-mono mb-2">No environment variables.</p>
      )}
      {entries.map((v, i) => (
        <div key={i} className="flex gap-2 items-center mt-2">
          <input
            type="text"
            value={v.key}
            placeholder="KEY"
            readOnly={readOnly || !!v.injected_by}
            onChange={(e) => update(i, "key", e.target.value)}
            className={`!w-1/3 ${readOnly ? "opacity-60" : ""}`}
          />
          <input
            type={v.secret ? "password" : "text"}
            value={v.value}
            placeholder={v.secret ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "value"}
            readOnly={readOnly || !!v.injected_by}
            onChange={(e) => update(i, "value", e.target.value)}
            className={readOnly ? "opacity-60" : ""}
          />
          {v.injected_by && (
            <span className="font-mono text-[9px] text-muted flex-shrink-0" title="Managed automatically; change the source configuration to update this value.">
              <Lock size={12} className="inline mr-1" />Injected · {v.injected_by}
            </span>
          )}
          {!readOnly && !v.injected_by && (
            <>
              <button
                type="button"
                onClick={() => {
                  const next = [...entries];
                  // When switching secret→plaintext, clear the masked value
                  // so the user re-enters it (frontend never has the real value).
                  if (v.secret) {
                    next[i] = { ...next[i], secret: false, value: "" };
                  } else {
                    next[i] = { ...next[i], secret: true };
                  }
                  onChange(next);
                }}
                className="text-muted hover:text-fg transition-colors flex-shrink-0"
                title={v.secret ? "Encrypted. Click to make plaintext (you'll need to re-enter the value)" : "Plaintext. Click to encrypt"}
              >
                {v.secret ? <Lock size={14} /> : <Unlock size={14} />}
              </button>
              <button
                type="button"
                onClick={() => onChange(entries.filter((_, j) => j !== i))}
                className="text-muted hover:text-accent-red transition-colors flex-shrink-0"
              >
                <Minus size={14} />
              </button>
            </>
          )}
        </div>
      ))}
      {!readOnly && (
        <Btn
          size="xs"
          variant="ghost"
          className="mt-2"
          onClick={() => onChange([...entries, { key: "", value: "", secret: false }])}
        >
          <Plus size={12} /> Add
        </Btn>
      )}
    </div>
  );
}
