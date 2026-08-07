import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Copy,
  Play,
  RefreshCw,
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

const inputClass = "w-full border-2 border-fg bg-bg-raised px-3 py-2.5 font-mono text-xs outline-none focus:shadow-neo-sm disabled:cursor-not-allowed disabled:bg-alt disabled:text-fg-dim";

const ROOT_META: Record<string, { label: string; description: string }> = {
  status: { label: "Status", description: "Dashboard overview" },
  apps: { label: "Apps", description: "List deployed applications" },
  app: { label: "App", description: "Inspect and operate an application" },
  logs: { label: "Logs", description: "Read application logs" },
  deploy: { label: "Deploy", description: "Apply repository manifests" },
  delete: { label: "Delete", description: "Remove apps or stacks" },
  restart: { label: "Restart", description: "Restart application replicas" },
  rollback: { label: "Rollback", description: "Restore an earlier deployment" },
  promote: { label: "Promote", description: "Promote staged releases" },
  pause: { label: "Pause", description: "Pause an application" },
  unpause: { label: "Unpause", description: "Resume an application" },
  scale: { label: "Scale", description: "Wake, inspect, and migrate" },
  envs: { label: "Environments", description: "Manage environment values" },
  service: { label: "Services", description: "Operate managed services" },
  stack: { label: "Stacks", description: "Inspect multi-app stacks" },
  ops: { label: "Operations", description: "Inspect and recover operations" },
  servers: { label: "Servers", description: "Inspect and manage servers" },
  resources: { label: "Resources", description: "Review infrastructure inventory" },
  volumes: { label: "Volumes", description: "Inspect retained and attached data" },
  ssh: { label: "SSH", description: "Interactive remote shell" },
  skill: { label: "Skill", description: "Install local agent support" },
  login: { label: "Login", description: "Authenticate a local CLI" },
};

function stripAnsi(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
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

function mapOperations(value: unknown): ResourceOption[] {
  if (!value || typeof value !== "object") return [];
  const snapshot = value as Record<string, unknown>;
  const rows = [snapshot.running, snapshot.pending, snapshot.recent]
    .flatMap((group) => Array.isArray(group) ? group : []);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (item.id === undefined || item.id === null) return [];
    const id = String(item.id);
    if (seen.has(id)) return [];
    seen.add(id);
    const label = String(item.label ?? item.kind ?? "Operation");
    const status = item.status ? ` · ${item.status}` : "";
    const targets = Array.isArray(item.resource_labels) && item.resource_labels.length
      ? ` · ${item.resource_labels.join(", ")}`
      : "";
    return [{ value: id, label: `${label}${status}${targets}` }];
  });
}

function mapDeployments(value: unknown): ResourceOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (item.id === undefined || item.id === null) return [];
    const commit = typeof item.git_commit === "string" && item.git_commit
      ? ` · ${item.git_commit.slice(0, 10)}`
      : "";
    return [{ value: String(item.id), label: `Deployment #${item.id} · ${item.status ?? "unknown"}${commit}` }];
  });
}

function mapReplicas(value: unknown): ResourceOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (item.id === undefined || item.id === null) return [];
    const name = String(item.container_name ?? `Replica #${item.id}`);
    const status = item.status ? ` · ${item.status}` : "";
    return [{ value: String(item.id), label: `${name}${status}` }];
  });
}

function mapServiceCatalog(value: unknown): { types: ResourceOption[]; versions: ResourceOption[] } {
  if (!Array.isArray(value)) return { types: [], versions: [] };
  const versions = new Set<string>();
  const types = value.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (typeof item.type !== "string") return [];
    if (Array.isArray(item.versions)) {
      for (const version of item.versions) if (typeof version === "string") versions.add(version);
    }
    return [{ value: item.type, label: String(item.label ?? item.type) }];
  });
  return { types, versions: Array.from(versions).map((version) => ({ value: version, label: version })) };
}

function mapServerCatalog(value: unknown): { types: ResourceOption[]; locations: ResourceOption[] } {
  if (!value || typeof value !== "object") return { types: [], locations: [] };
  const rows = (value as { server_types?: unknown }).server_types;
  if (!Array.isArray(rows)) return { types: [], locations: [] };
  const locations = new Set<string>();
  const types = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    if (typeof item.name !== "string") return [];
    if (Array.isArray(item.locations)) {
      for (const location of item.locations) if (typeof location === "string") locations.add(location);
    }
    const shape = item.cores && item.memory ? ` · ${item.cores}c/${item.memory}GB` : "";
    return [{ value: item.name, label: `${item.name}${shape}` }];
  });
  return { types, locations: Array.from(locations).map((location) => ({ value: location, label: location })) };
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
    get("/api/operations"),
    get("/api/services/catalog"),
    get("/api/admin/settings/server-types"),
  ]);
  const value = (index: number): unknown => requests[index].status === "fulfilled" ? requests[index].value : [];
  const inventory = value(6) as { volumes?: unknown } | undefined;
  const serviceCatalog = mapServiceCatalog(value(8));
  const serverCatalog = mapServerCatalog(value(9));
  return {
    app: mapRows(value(0), "app"),
    environment: mapRows(value(1), "environment"),
    "deleted-environment": mapRows(value(2), "deleted-environment"),
    service: mapRows(value(3), "service"),
    stack: mapRows(value(4), "stack"),
    server: mapRows(value(5), "server"),
    volume: mapRows(inventory?.volumes, "volume"),
    operation: mapOperations(value(7)),
    deployment: [],
    replica: [],
    "service-instance": [],
    "service-type": serviceCatalog.types,
    "service-version": serviceCatalog.versions,
    "server-type": serverCatalog.types,
    location: serverCatalog.locations,
  };
}

export function WebCliPage() {
  const { token } = useAuth();
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<WebCliValues>({});
  const [resources, setResources] = useState<ResourceOptions>({});
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState<Partial<Record<WebCliResource, boolean>>>({});
  const [search, setSearch] = useState("");
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);
  const selected = selectedId
    ? WEB_CLI_COMMANDS.find((command) => command.id === selectedId) ?? null
    : null;

  const refreshResources = useCallback(async () => {
    setResourcesLoading(true);
    try {
      setResources(await loadResources());
    } finally {
      setResourcesLoading(false);
    }
  }, []);

  useEffect(() => { refreshResources().catch(() => {}); }, [refreshResources]);

  useEffect(() => {
    let cancelled = false;
    const needsDeployments = !!selected?.inputs.some((input) => input.resource === "deployment");
    const needsReplicas = !!selected?.inputs.some((input) => input.resource === "replica");
    const appId = typeof values.app === "string" ? values.app : "";
    if (!needsDeployments && !needsReplicas) return;
    setResources((current) => ({
      ...current,
      ...(needsDeployments ? { deployment: [] } : {}),
      ...(needsReplicas ? { replica: [] } : {}),
    }));
    setContextLoading((current) => ({
      ...current,
      ...(needsDeployments ? { deployment: false } : {}),
      ...(needsReplicas ? { replica: false } : {}),
    }));
    if (!appId) return;
    setContextLoading((current) => ({
      ...current,
      ...(needsDeployments ? { deployment: true } : {}),
      ...(needsReplicas ? { replica: true } : {}),
    }));
    Promise.all([
      needsDeployments ? get(`/api/apps/${encodeURIComponent(appId)}/deployments`) : Promise.resolve([]),
      needsReplicas ? get(`/api/apps/${encodeURIComponent(appId)}/replicas`) : Promise.resolve([]),
    ]).then(([deployments, replicas]) => {
      if (cancelled) return;
      setResources((current) => ({
        ...current,
        ...(needsDeployments ? { deployment: mapDeployments(deployments) } : {}),
        ...(needsReplicas ? { replica: mapReplicas(replicas) } : {}),
      }));
    }).catch(() => {}).finally(() => {
      if (cancelled) return;
      setContextLoading((current) => ({
        ...current,
        ...(needsDeployments ? { deployment: false } : {}),
        ...(needsReplicas ? { replica: false } : {}),
      }));
    });
    return () => { cancelled = true; };
  }, [selectedId, values.app]);

  useEffect(() => {
    let cancelled = false;
    const needsInstances = !!selected?.inputs.some((input) => input.resource === "service-instance");
    const serviceId = typeof values.service === "string" ? values.service : "";
    if (!needsInstances) return;
    setResources((current) => ({ ...current, "service-instance": [] }));
    setContextLoading((current) => ({ ...current, "service-instance": false }));
    if (!serviceId) return;
    setContextLoading((current) => ({ ...current, "service-instance": true }));
    get(`/api/services/${encodeURIComponent(serviceId)}`).then((service) => {
      if (cancelled) return;
      const detail = service as { instances?: unknown };
      setResources((current) => ({
        ...current,
        "service-instance": mapReplicas(detail.instances),
      }));
    }).catch(() => {}).finally(() => {
      if (!cancelled) setContextLoading((current) => ({ ...current, "service-instance": false }));
    });
    return () => { cancelled = true; };
  }, [selectedId, values.service]);

  useEffect(() => {
    if (!selected) return;
    setValues(defaultsFor(selected));
    setOutput("");
    setExitCode(null);
  }, [selectedId]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);

  const roots = useMemo(() => {
    const names = Array.from(new Set(WEB_CLI_COMMANDS.map((command) => command.args[0])));
    const query = search.trim().toLowerCase();
    return names.map((name) => {
      const commands = WEB_CLI_COMMANDS.filter((command) => command.args[0] === name);
      const meta = ROOT_META[name] ?? { label: name, description: `Run ocd ${name}` };
      return { name, commands, ...meta };
    }).filter((root) =>
      !query || `${root.name} ${root.label} ${root.description} ${root.commands.map((command) => command.label).join(" ")}`.toLowerCase().includes(query)
    );
  }, [search]);

  const rootCommands = useMemo(() => {
    if (!selectedRoot) return [];
    const query = search.trim().toLowerCase();
    return WEB_CLI_COMMANDS
      .filter((command) => command.args[0] === selectedRoot)
      .filter((command) => !query || `${command.label} ${command.description} ${command.args.join(" ")}`.toLowerCase().includes(query));
  }, [selectedRoot, search]);

  const preview = useMemo(() => {
    if (!selected) return "";
    try {
      return formatWebCliCommand(buildWebCliArgv(selected, values));
    } catch {
      return formatWebCliCommand(selected.args);
    }
  }, [selected, values]);

  const chooseRoot = (root: string) => {
    if (running) return;
    setSelectedRoot(root);
    setSelectedId(null);
    setSearch("");
  };

  const chooseCommand = (command: WebCliCommand) => {
    if (running) return;
    setSelectedId(command.id);
    setSearch("");
  };

  const back = () => {
    if (running) return;
    if (selectedId) {
      setSelectedId(null);
      setValues({});
      setOutput("");
      setExitCode(null);
    } else {
      setSelectedRoot(null);
    }
    setSearch("");
  };

  const setValue = (key: string, value: string | boolean) => {
    setValues((current) => ({
      ...current,
      [key]: value,
      ...(key === "app" ? { deployment: undefined, replica: undefined } : {}),
      ...(key === "service" ? { instance: undefined } : {}),
    }));
  };

  async function run() {
    if (!selected) return;
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
        `${formatWebCliCommand(argv)}\n\nThis command changes live infrastructure. Existing OCD permissions still apply.`,
        true,
      );
      if (!confirmed) return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setExitCode(null);
    setOutput("");
    let commandLine = formatWebCliCommand(argv);
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

  const stage = selected ? 3 : selectedRoot ? 2 : 1;
  const rootMeta = selectedRoot ? ROOT_META[selectedRoot] : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 pb-24 animate-fade-in">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <TerminalSquare size={22} />
            <h1 className="font-mono text-xl font-bold uppercase tracking-wider">Web CLI</h1>
          </div>
          <p className="max-w-2xl text-xs text-fg-dim">Navigate the real OCD command tree, choose contextual values, then run the exact CLI command on this panel.</p>
        </div>
        <span className="border-2 border-fg bg-accent px-2 py-1 font-mono text-[9px] font-bold uppercase shadow-neo-sm">CLI is authoritative</span>
      </div>

      <div className="mb-6 flex items-center gap-2 font-mono text-[10px] font-bold uppercase">
        <Step active={stage === 1} done={stage > 1} number="1" label="Command" />
        <span className="h-0.5 w-6 bg-fg/25" />
        <Step active={stage === 2} done={stage > 2} number="2" label="Action" />
        <span className="h-0.5 w-6 bg-fg/25" />
        <Step active={stage === 3} done={false} number="3" label="Parameters" />
      </div>

      {(selectedRoot || selected) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button onClick={back} disabled={running} className="inline-flex items-center gap-1.5 border-2 border-fg bg-bg-raised px-3 py-2 font-mono text-[10px] font-bold uppercase shadow-neo-sm disabled:opacity-40">
            <ArrowLeft size={14} /> Back
          </button>
          <button onClick={() => { if (!running) { setSelectedRoot(null); setSelectedId(null); setSearch(""); } }} disabled={running} className="font-mono text-[10px] font-bold uppercase text-fg-dim hover:text-fg disabled:opacity-40">All commands</button>
          {selectedRoot && <><ChevronRight size={13} className="text-fg-dim" /><button onClick={() => { if (!running) setSelectedId(null); }} disabled={running} className="font-mono text-[10px] font-bold uppercase text-fg-dim hover:text-fg disabled:opacity-40">ocd {selectedRoot}</button></>}
          {selected && <><ChevronRight size={13} className="text-fg-dim" /><span className="font-mono text-[10px] font-bold uppercase">{selected.label}</span></>}
        </div>
      )}

      {!selected && (
        <div className="mx-auto mb-5 max-w-xl">
          <label className="flex items-center gap-2 border-2 border-fg bg-bg-raised px-3 shadow-neo-sm">
            <Search size={15} className="shrink-0 text-fg-dim" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={selectedRoot ? `Find an ocd ${selectedRoot} action` : "Find a top-level command"} className="min-w-0 flex-1 bg-transparent py-3 font-mono text-xs outline-none" />
          </label>
        </div>
      )}

      {!selectedRoot && (
        <section>
          <div className="mb-5 text-center">
            <h2 className="font-mono text-lg font-bold uppercase tracking-wider">Choose a command</h2>
            <p className="mt-1 text-xs text-fg-dim">Start with the same top-level command you would type after <code className="font-mono">ocd</code>.</p>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {roots.map((root) => (
              <button key={root.name} onClick={() => chooseRoot(root.name)} className="group min-h-36 border-2 border-fg bg-bg-raised p-5 text-left shadow-neo transition-all hover:translate-x-0.5 hover:translate-y-0.5 hover:bg-accent hover:shadow-neo-none">
                <div className="mb-4 flex items-start justify-between gap-3">
                  <code className="border-2 border-fg bg-fg px-2 py-1 font-mono text-[10px] font-bold text-accent">ocd {root.name}</code>
                  <ChevronRight size={20} className="transition-transform group-hover:translate-x-1" />
                </div>
                <h3 className="font-mono text-base font-bold uppercase">{root.label}</h3>
                <p className="mt-1 text-xs text-fg-dim group-hover:text-fg/70">{root.description}</p>
                <div className="mt-4 font-mono text-[9px] font-bold uppercase text-fg-dim">{root.commands.length} {root.commands.length === 1 ? "action" : "actions"}</div>
              </button>
            ))}
          </div>
          {roots.length === 0 && <Empty label="No commands match this search" />}
        </section>
      )}

      {selectedRoot && !selected && (
        <section>
          <div className="mb-5 text-center">
            <code className="inline-block border-2 border-fg bg-fg px-2 py-1 font-mono text-[10px] font-bold text-accent">ocd {selectedRoot}</code>
            <h2 className="mt-3 font-mono text-lg font-bold uppercase tracking-wider">Choose an action</h2>
            <p className="mt-1 text-xs text-fg-dim">{rootMeta?.description ?? `Available ${selectedRoot} actions`}</p>
          </div>
          <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rootCommands.map((command) => (
              <button key={command.id} onClick={() => chooseCommand(command)} className={`group min-h-40 border-2 border-fg p-5 text-left shadow-neo transition-all hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-neo-none ${command.unavailableReason ? "bg-alt" : "bg-bg-raised hover:bg-accent"}`}>
                <div className="mb-4 flex items-start justify-between gap-3">
                  <code className="break-all font-mono text-[10px] font-bold text-fg-dim">{formatWebCliCommand(command.args)}</code>
                  {command.unavailableReason ? <Ban size={18} className="shrink-0 text-fg-dim" /> : <ChevronRight size={19} className="shrink-0 transition-transform group-hover:translate-x-1" />}
                </div>
                <h3 className="font-mono text-sm font-bold uppercase">{command.label}</h3>
                <p className="mt-2 text-xs leading-5 text-fg-dim">{command.description}</p>
                {command.danger && <span className="mt-3 inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase text-amber-700"><AlertTriangle size={11} /> Confirmation required</span>}
              </button>
            ))}
          </div>
          {rootCommands.length === 0 && <Empty label="No actions match this search" />}
        </section>
      )}

      {selected && (
        <section className="mx-auto max-w-4xl">
          <div className="border-2 border-fg bg-bg-raised shadow-neo">
            <div className="border-b-2 border-fg p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <code className="font-mono text-[10px] font-bold text-fg-dim">{formatWebCliCommand(selected.args)}</code>
                  <h2 className="mt-1 font-mono text-lg font-bold uppercase">{selected.label}</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-dim">{selected.description}</p>
                </div>
                {selected.danger && <span className="inline-flex items-center gap-1 border-2 border-fg bg-accent-amber px-2 py-1 font-mono text-[9px] font-bold uppercase"><AlertTriangle size={12} /> Changes infrastructure</span>}
              </div>

              {selected.unavailableReason ? (
                <div className="mt-5 border-2 border-fg bg-alt p-4">
                  <div className="flex gap-3"><Ban size={18} className="shrink-0" /><div><div className="font-mono text-[10px] font-bold uppercase">Local CLI required</div><p className="mt-1 text-xs leading-5 text-fg-dim">{selected.unavailableReason}</p></div></div>
                </div>
              ) : (
                <>
                  <div className="mt-6 flex items-center justify-between gap-3">
                    <h3 className="font-mono text-[10px] font-bold uppercase tracking-widest">Contextual parameters</h3>
                    <button onClick={() => refreshResources().catch(() => {})} disabled={resourcesLoading} className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase text-fg-dim hover:text-fg disabled:opacity-40"><RefreshCw size={11} className={resourcesLoading ? "animate-spin" : ""} /> Refresh choices</button>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {selected.inputs.map((input) => (
                      <InputField key={input.key} input={input} value={values[input.key]} options={input.resource ? resources[input.resource] : undefined} resourcesLoading={resourcesLoading || !!(input.resource && contextLoading[input.resource])} onChange={(value) => setValue(input.key, value)} />
                    ))}
                    {selected.inputs.length === 0 && <div className="sm:col-span-2 border-2 border-dashed border-fg/25 p-5 text-center font-mono text-[10px] text-fg-dim">This command needs no parameters. Review it below and run.</div>}
                  </div>
                </>
              )}
            </div>

            <div className="border-b-2 border-fg bg-fg p-4 text-accent">
              <div className="mb-1 font-mono text-[8px] font-bold uppercase tracking-widest text-accent/60">Exact command</div>
              <code className="break-all font-mono text-xs">$ {preview}</code>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b-2 border-fg p-4">
              <button disabled={!!selected.unavailableReason || running} onClick={run} className="inline-flex items-center gap-2 border-2 border-fg bg-accent px-5 py-2.5 font-mono text-[10px] font-bold uppercase shadow-neo-sm transition-all enabled:hover:translate-x-0.5 enabled:hover:translate-y-0.5 enabled:hover:shadow-neo-none disabled:cursor-not-allowed disabled:opacity-40">
                <Play size={14} fill="currentColor" /> {running ? "Running…" : "Run command"}
              </button>
              {running && <button onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-2 border-2 border-fg bg-accent-red px-3 py-2.5 font-mono text-[10px] font-bold uppercase text-white"><CircleStop size={14} /> Stop</button>}
              {exitCode !== null && <span className={`ml-auto inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase ${exitCode === 0 ? "text-green-700" : "text-accent-red"}`}><CheckCircle2 size={14} /> Exit {exitCode}</span>}
            </div>

            <div className="relative min-h-[260px] bg-[#151713]">
              <button disabled={!output} onClick={() => navigator.clipboard.writeText(output)} className="absolute right-3 top-3 z-10 border border-white/30 bg-black/40 p-1.5 text-white/60 hover:text-white disabled:opacity-30" title="Copy output"><Copy size={13} /></button>
              <pre ref={outputRef} className="min-h-[260px] max-h-[440px] overflow-auto whitespace-pre-wrap break-words p-4 pr-12 font-mono text-[11px] leading-5 text-[#d9f99d]">{output || "Command output will appear here."}</pre>
            </div>
          </div>
        </section>
      )}

      {history.length > 0 && <section className="mx-auto mt-6 max-w-4xl"><h2 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest">This session</h2><div className="border-2 border-fg bg-bg-raised">{history.map((item, index) => <div key={`${item.at.getTime()}-${index}`} className="flex gap-3 border-b border-fg/15 px-3 py-2 last:border-b-0"><span className={`font-mono text-[9px] font-bold ${item.code === 0 ? "text-green-700" : "text-accent-red"}`}>{item.code}</span><code className="min-w-0 flex-1 truncate font-mono text-[10px]">{item.command}</code><span className="font-mono text-[9px] text-fg-dim">{item.at.toLocaleTimeString()}</span></div>)}</div></section>}
    </div>
  );
}

function Step({ active, done, number, label }: { active: boolean; done: boolean; number: string; label: string }) {
  return <div className={`flex items-center gap-1.5 ${active ? "text-fg" : "text-fg-dim"}`}><span className={`grid h-5 w-5 place-items-center border-2 border-fg text-[9px] ${active || done ? "bg-fg text-accent" : "bg-bg-raised"}`}>{done ? "✓" : number}</span><span>{label}</span></div>;
}

function Empty({ label }: { label: string }) {
  return <div className="mx-auto max-w-2xl border-2 border-dashed border-fg/25 p-8 text-center font-mono text-xs text-fg-dim">{label}</div>;
}

function InputField({ input, value, options, resourcesLoading, onChange }: { input: WebCliInput; value: string | boolean | string[] | undefined; options?: ResourceOption[]; resourcesLoading: boolean; onChange: (value: string | boolean) => void }) {
  const stringValue = typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : "";
  const resourceOptions = options ?? [];
  const showResourceId = !input.resource || !["service-type", "service-version", "server-type", "location"].includes(input.resource);
  return (
    <label className={input.repeatable || input.kind === "key-value" ? "sm:col-span-2" : ""}>
      <div className="mb-1 flex items-center gap-1 font-mono text-[10px] font-bold uppercase">{input.label}{input.required && <span className="text-accent-red">*</span>}</div>
      {input.description && <p className="mb-1.5 text-[10px] leading-4 text-fg-dim">{input.description}</p>}
      {input.kind === "boolean" ? (
        <button type="button" onClick={() => onChange(value !== true)} className={`flex w-full items-center justify-between border-2 border-fg px-3 py-2.5 font-mono text-xs ${value === true ? "bg-accent" : "bg-bg-raised"}`}><span>{value === true ? "Enabled" : "Disabled"}</span><span className={`h-4 w-8 border-2 border-fg p-0.5 ${value === true ? "bg-fg" : "bg-alt"}`}><span className={`block h-2 w-2 bg-accent transition-transform ${value === true ? "translate-x-4" : ""}`} /></span></button>
      ) : input.kind === "select" ? (
        <select value={stringValue} onChange={(event) => onChange(event.target.value)} className={inputClass}><option value="">Select…</option>{input.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      ) : input.kind === "resource" ? (
        <>
          <select disabled={resourcesLoading || resourceOptions.length === 0} value={stringValue} onChange={(event) => onChange(event.target.value)} className={inputClass}>
            <option value="">{resourcesLoading ? `Loading ${input.label.toLowerCase()} choices…` : resourceOptions.length === 0 ? `No ${input.label.toLowerCase()} choices available` : `Select ${input.label.toLowerCase()}…`}</option>
            {resourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}{showResourceId ? ` · #${option.value}` : ""}</option>)}
          </select>
          {!resourcesLoading && resourceOptions.length === 0 && <p className="mt-1.5 text-[10px] text-fg-dim">No accessible {input.label.toLowerCase()} exists for this command.</p>}
        </>
      ) : input.repeatable || input.kind === "key-value" ? (
        <textarea value={stringValue} onChange={(event) => onChange(event.target.value)} rows={3} placeholder={input.placeholder || "One value per line"} className={`${inputClass} resize-y`} />
      ) : (
        <input type={input.kind === "number" ? "number" : "text"} min={input.min} max={input.max} value={stringValue} onChange={(event) => onChange(event.target.value)} placeholder={input.placeholder} className={inputClass} />
      )}
    </label>
  );
}
