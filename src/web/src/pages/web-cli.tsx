import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Copy,
  Play,
  Search,
  TerminalSquare,
} from "lucide-react";
import { get } from "../api/client.ts";
import { useAuth } from "../stores/auth.ts";
import { confirm, showToast } from "../components/ui.tsx";
import {
  buildWebCliArgv,
  formatWebCliCommand,
  WEB_CLI_COMMANDS,
  type WebCliCommand,
  type WebCliInput,
  type WebCliResource,
  type WebCliValues,
} from "../../../shared/web-cli.ts";

type ResourceOption = { value: string; label: string };
type ResourceOptions = Partial<Record<WebCliResource, ResourceOption[]>>;
type RunRecord = { command: string; code: number | null; at: Date };

const inputClass = "w-full border-2 border-fg bg-bg-raised px-3 py-2 font-mono text-xs outline-none focus:shadow-neo-sm";

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function shellDisplay(argv: string[]): string {
  return formatWebCliCommand(argv);
}

function defaultsFor(command: WebCliCommand): WebCliValues {
  return Object.fromEntries(
    command.inputs
      .filter((input) => input.defaultValue !== undefined)
      .map((input) => [input.key, input.defaultValue]),
  );
}

function mapRows(rows: unknown, kind: WebCliResource): ResourceOption[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const id = item.id ?? item.provider_id;
    if (id === undefined || id === null) return [];
    const name = String(item.name ?? item.provider_volume_name ?? id);
    const detail = kind === "server" && item.location ? ` · ${item.location}`
      : kind === "service" && item.service_type ? ` · ${item.service_type}`
      : "";
    return [{ value: String(id), label: `${name}${detail}` }];
  });
}

async function loadResources(): Promise<ResourceOptions> {
  const requests = await Promise.allSettled([
    get("/api/apps"),
    get("/api/environments"),
    get("/api/environments/deleted"),
    get("/api/services"),
    get("/api/stacks"),
    get("/api/servers"),
    get("/api/resources"),
  ]);
  const value = (index: number): unknown => requests[index].status === "fulfilled" ? requests[index].value : [];
  const resources = value(6) as { volumes?: unknown } | undefined;
  return {
    app: mapRows(value(0), "app"),
    environment: mapRows(value(1), "environment"),
    "deleted-environment": mapRows(value(2), "deleted-environment"),
    service: mapRows(value(3), "service"),
    stack: mapRows(value(4), "stack"),
    server: mapRows(value(5), "server"),
    volume: mapRows(resources?.volumes, "volume"),
  };
}

export function WebCliPage() {
  const { token } = useAuth();
  const [selectedId, setSelectedId] = useState("status");
  const [values, setValues] = useState<WebCliValues>({});
  const [resources, setResources] = useState<ResourceOptions>({});
  const [search, setSearch] = useState("");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const selected = WEB_CLI_COMMANDS.find((command) => command.id === selectedId)!;

  useEffect(() => {
    loadResources().then(setResources).catch(() => {});
  }, []);

  useEffect(() => {
    setValues(defaultsFor(selected));
    setOutput("");
    setExitCode(null);
  }, [selectedId]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const preview = useMemo(() => {
    try {
      return shellDisplay(buildWebCliArgv(selected, values));
    } catch {
      return shellDisplay(selected.args);
    }
  }, [selected, values]);

  const categories = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = WEB_CLI_COMMANDS.filter((command) =>
      !query || `${command.label} ${command.description} ${command.args.join(" ")}`.toLowerCase().includes(query)
    );
    return Array.from(new Set(filtered.map((command) => command.category))).map((category) => ({
      category,
      commands: filtered.filter((command) => command.category === category),
    }));
  }, [search]);

  const setValue = (key: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  async function run() {
    let argv: string[];
    try {
      argv = buildWebCliArgv(selected, values);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Invalid command", "error");
      return;
    }
    let confirmed = false;
    if (selected.danger) {
      confirmed = await confirm(
        `Run ${selected.label}?`,
        `${shellDisplay(argv)}\n\nThis command changes live infrastructure. Existing OCD permissions still apply.`,
        true,
      );
      if (!confirmed) return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setExitCode(null);
    setOutput("");
    let commandLine = shellDisplay(argv);
    try {
      const response = await fetch(`${window.location.origin}/api/web-cli/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ command_id: selected.id, values, confirmed }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(body.error || `Command failed (${response.status})`);
      }
      if (!response.body) throw new Error("The panel returned no command stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line) continue;
          const item = JSON.parse(line) as { type: string; data?: string; command?: string; code?: number; error?: string; timed_out?: boolean };
          if (item.type === "start" && item.command) {
            commandLine = item.command;
            setOutput(`$ ${item.command}\n\n`);
          } else if (item.type === "stdout" || item.type === "stderr") {
            setOutput((current) => current + stripAnsi(item.data || ""));
          } else if (item.type === "exit") {
            const code = item.code ?? 1;
            setExitCode(code);
            setOutput((current) => `${current}\n[${item.timed_out ? "timed out" : `exit ${code}`}]\n`);
            setHistory((current) => [{ command: commandLine, code, at: new Date() }, ...current].slice(0, 8));
          } else if (item.type === "error") {
            throw new Error(item.error || "CLI execution failed");
          }
        }
        if (done) break;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setOutput((current) => `${current}\n[cancelled]\n`);
      } else {
        const message = err instanceof Error ? err.message : "CLI execution failed";
        setOutput((current) => `${current}\n[error] ${message}\n`);
        showToast(message, "error");
      }
      setExitCode(1);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 pb-24 animate-fade-in">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <TerminalSquare size={22} />
            <h1 className="font-mono text-xl font-bold uppercase tracking-wider">Web CLI</h1>
          </div>
          <p className="max-w-2xl text-xs text-fg-dim">Choose a real OCD command, fill its typed parameters, and run it on the panel as your signed-in CLI identity.</p>
        </div>
        <span className="border-2 border-fg bg-accent px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-neo-sm">CLI is authoritative</span>
      </div>

      <div className="grid min-h-[680px] grid-cols-1 border-2 border-fg bg-bg-raised shadow-neo lg:grid-cols-[260px_1fr]">
        <aside className="border-b-2 border-fg bg-alt/40 lg:border-b-0 lg:border-r-2">
          <div className="border-b-2 border-fg p-3">
            <label className="flex items-center gap-2 border-2 border-fg bg-bg-raised px-2">
              <Search size={14} className="shrink-0 text-fg-dim" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find command" className="min-w-0 flex-1 bg-transparent py-2 font-mono text-xs outline-none" />
            </label>
          </div>
          <div className="max-h-[615px] overflow-y-auto p-2">
            {categories.map(({ category, commands }) => (
              <div key={category} className="mb-3">
                <div className="px-2 pb-1 font-mono text-[9px] font-bold uppercase tracking-widest text-fg-dim">{category}</div>
                {commands.map((command) => (
                  <button
                    key={command.id}
                    onClick={() => !running && setSelectedId(command.id)}
                    className={`mb-1 flex w-full items-center gap-2 border-2 px-2 py-2 text-left transition-all ${selectedId === command.id ? "border-fg bg-fg text-accent" : "border-transparent hover:border-fg/30 hover:bg-bg-raised"}`}
                  >
                    {command.unavailableReason ? <Ban size={12} className="shrink-0 opacity-60" /> : <ChevronRight size={12} className="shrink-0" />}
                    <span className="font-mono text-[10px] font-bold uppercase">{command.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-col">
          <div className="border-b-2 border-fg p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-mono text-base font-bold uppercase">{selected.label}</h2>
                <p className="mt-1 max-w-2xl text-xs text-fg-dim">{selected.description}</p>
              </div>
              {selected.danger && <span className="inline-flex items-center gap-1 border-2 border-fg bg-accent-amber px-2 py-1 font-mono text-[9px] font-bold uppercase"><AlertTriangle size={12} /> Changes infrastructure</span>}
            </div>

            {selected.unavailableReason ? (
              <div className="mt-5 border-2 border-fg bg-alt p-4">
                <div className="flex gap-3"><Ban size={18} className="shrink-0" /><div><div className="font-mono text-[10px] font-bold uppercase">Local CLI required</div><p className="mt-1 text-xs text-fg-dim">{selected.unavailableReason}</p></div></div>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {selected.inputs.map((input) => (
                  <InputField key={input.key} input={input} value={values[input.key]} options={input.resource ? resources[input.resource] : undefined} onChange={(value) => setValue(input.key, value)} />
                ))}
                {selected.inputs.length === 0 && <div className="sm:col-span-2 border-2 border-dashed border-fg/25 p-4 text-center font-mono text-[10px] text-fg-dim">No parameters required</div>}
              </div>
            )}
          </div>

          <div className="border-b-2 border-fg bg-fg p-3 text-accent">
            <div className="mb-1 font-mono text-[8px] font-bold uppercase tracking-widest text-accent/60">Exact command</div>
            <code className="break-all font-mono text-xs">$ {preview}</code>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b-2 border-fg p-3">
            <button disabled={!!selected.unavailableReason || running} onClick={run} className="inline-flex items-center gap-2 border-2 border-fg bg-accent px-4 py-2 font-mono text-[10px] font-bold uppercase shadow-neo-sm transition-all enabled:hover:translate-x-0.5 enabled:hover:translate-y-0.5 enabled:hover:shadow-neo-none disabled:cursor-not-allowed disabled:opacity-40">
              <Play size={14} fill="currentColor" /> {running ? "Running…" : "Run command"}
            </button>
            {running && <button onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-2 border-2 border-fg bg-accent-red px-3 py-2 font-mono text-[10px] font-bold uppercase text-white"><CircleStop size={14} /> Stop</button>}
            {exitCode !== null && <span className={`ml-auto inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase ${exitCode === 0 ? "text-green-700" : "text-accent-red"}`}><CheckCircle2 size={14} /> Exit {exitCode}</span>}
          </div>

          <div className="relative min-h-[280px] flex-1 bg-[#151713]">
            <button disabled={!output} onClick={() => navigator.clipboard.writeText(output)} className="absolute right-3 top-3 z-10 border border-white/30 bg-black/40 p-1.5 text-white/60 hover:text-white disabled:opacity-30" title="Copy output"><Copy size={13} /></button>
            <pre ref={outputRef} className="h-full min-h-[280px] max-h-[440px] overflow-auto whitespace-pre-wrap break-words p-4 pr-12 font-mono text-[11px] leading-5 text-[#d9f99d]">{output || "Command output will appear here."}</pre>
          </div>
        </main>
      </div>

      {history.length > 0 && <section className="mt-5"><h2 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest">This session</h2><div className="border-2 border-fg bg-bg-raised">{history.map((item, index) => <div key={`${item.at.getTime()}-${index}`} className="flex gap-3 border-b border-fg/15 px-3 py-2 last:border-b-0"><span className={`font-mono text-[9px] font-bold ${item.code === 0 ? "text-green-700" : "text-accent-red"}`}>{item.code}</span><code className="min-w-0 flex-1 truncate font-mono text-[10px]">{item.command}</code><span className="font-mono text-[9px] text-fg-dim">{item.at.toLocaleTimeString()}</span></div>)}</div></section>}
    </div>
  );
}

function InputField({ input, value, options, onChange }: { input: WebCliInput; value: string | boolean | string[] | undefined; options?: ResourceOption[]; onChange: (value: string | boolean) => void }) {
  const stringValue = typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : "";
  return (
    <label className={input.repeatable || input.kind === "key-value" ? "sm:col-span-2" : ""}>
      <div className="mb-1 flex items-center gap-1 font-mono text-[10px] font-bold uppercase">{input.label}{input.required && <span className="text-accent-red">*</span>}</div>
      {input.description && <p className="mb-1.5 text-[10px] leading-4 text-fg-dim">{input.description}</p>}
      {input.kind === "boolean" ? (
        <button type="button" onClick={() => onChange(value !== true)} className={`flex w-full items-center justify-between border-2 border-fg px-3 py-2 font-mono text-xs ${value === true ? "bg-accent" : "bg-bg-raised"}`}><span>{value === true ? "Enabled" : "Disabled"}</span><span className={`h-4 w-8 border-2 border-fg p-0.5 ${value === true ? "bg-fg" : "bg-alt"}`}><span className={`block h-2 w-2 bg-accent transition-transform ${value === true ? "translate-x-4" : ""}`} /></span></button>
      ) : input.kind === "select" ? (
        <select value={stringValue} onChange={(event) => onChange(event.target.value)} className={inputClass}><option value="">Select…</option>{input.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      ) : input.kind === "resource" && options && options.length > 0 ? (
        <select value={stringValue} onChange={(event) => onChange(event.target.value)} className={inputClass}><option value="">Select {input.label.toLowerCase()}…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label} · #{option.value}</option>)}</select>
      ) : input.repeatable || input.kind === "key-value" ? (
        <textarea value={stringValue} onChange={(event) => onChange(event.target.value)} rows={3} placeholder={input.placeholder || "One value per line"} className={`${inputClass} resize-y`} />
      ) : (
        <input type={input.kind === "number" ? "number" : "text"} min={input.min} max={input.max} value={stringValue} onChange={(event) => onChange(event.target.value)} placeholder={input.placeholder} className={inputClass} />
      )}
    </label>
  );
}
