import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { get } from "../api/client.ts";
import { useAuth } from "../stores/auth.ts";
import { confirm, showToast } from "../components/ui.tsx";
import { TerminalViewport, type TerminalViewportHandle } from "../components/terminal-viewport.tsx";
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

const inputClass = "w-full border border-white/20 bg-black/30 px-3 py-2.5 font-mono text-xs text-[#eefbd5] outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-40";

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
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const terminalRef = useRef<TerminalViewportHandle>(null);
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
    setOptionsExpanded(false);
    setMenuOpen(true);
  }, [selectedId]);

  useEffect(() => {
    if (!selected || resourcesLoading) return;
    const singletonDefaults = Object.fromEntries(selected.inputs.flatMap((input) => {
      if (!input.required || values[input.key] !== undefined || input.kind !== "resource" || !input.resource) return [];
      const choices = resources[input.resource] ?? [];
      return choices.length === 1 ? [[input.key, choices[0].value]] : [];
    }));
    if (Object.keys(singletonDefaults).length > 0) {
      setValues((current) => ({ ...singletonDefaults, ...current }));
    }
  }, [selected, resources, resourcesLoading, values]);

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

  const validationError = useMemo(() => {
    if (!selected || selected.unavailableReason) return null;
    try {
      buildWebCliArgv(selected, values);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Complete the required parameters";
    }
  }, [selected, values]);

  useEffect(() => {
    if (!terminalReady || running || output) return;
    const command = selected ? preview : selectedRoot ? `ocd ${selectedRoot}` : "ocd";
    terminalRef.current?.reset();
    terminalRef.current?.write(`\x1b[1;92m$\x1b[0m ${command} \x1b[5;92m_\x1b[0m`);
  }, [terminalReady, selected, selectedRoot, preview, running, output]);

  const chooseRoot = (root: string) => {
    if (running) return;
    const commands = WEB_CLI_COMMANDS.filter((command) => command.args[0] === root);
    setSelectedRoot(root);
    setSelectedId(commands.length === 1 ? commands[0].id : null);
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
      const commands = WEB_CLI_COMMANDS.filter((command) => command.args[0] === selectedRoot);
      if (commands.length === 1) setSelectedRoot(null);
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
    setOutput("");
    setExitCode(null);
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
    setMenuOpen(false);
    setExitCode(null);
    let commandLine = formatWebCliCommand(argv);
    setOutput(`$ ${commandLine}\n\n`);
    terminalRef.current?.reset();
    terminalRef.current?.write(`\x1b[1;92m$\x1b[0m ${commandLine}\r\n\r\n`);
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
            terminalRef.current?.reset();
            terminalRef.current?.write(`\x1b[1;92m$\x1b[0m ${item.command}\r\n\r\n`);
          } else if (item.type === "stdout" || item.type === "stderr") {
            setOutput((current) => current + stripAnsi(item.data || ""));
            terminalRef.current?.write(item.data || "");
          } else if (item.type === "exit") {
            const code = item.code ?? 1;
            setExitCode(code);
            setOutput((current) => `${current}\n[${item.timed_out ? "timed out" : `exit ${code}`}]\n`);
            terminalRef.current?.write(`\r\n\x1b[2m[${item.timed_out ? "timed out" : `exit ${code}`}]\x1b[0m\r\n`);
          } else if (item.type === "error") {
            throw new Error(item.error || "CLI execution failed");
          }
        }
        if (done) break;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setOutput((current) => `${current}\n[cancelled]\n`);
        terminalRef.current?.write("\r\n\x1b[33m[cancelled]\x1b[0m\r\n");
      } else {
        const message = err instanceof Error ? err.message : "CLI execution failed";
        setOutput((current) => `${current}\n[error] ${message}\n`);
        terminalRef.current?.write(`\r\n\x1b[31m[error] ${message}\x1b[0m\r\n`);
        showToast(message, "error");
      }
      setExitCode(1);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const rootMeta = selectedRoot ? ROOT_META[selectedRoot] : null;
  const requiredInputs = selected?.inputs.filter((input) => input.required) ?? [];
  const optionalInputs = selected?.inputs.filter((input) => !input.required) ?? [];

  const resetToRoot = () => {
    if (running) return;
    setSelectedRoot(null);
    setSelectedId(null);
    setValues({});
    setSearch("");
    setOutput("");
    setExitCode(null);
    setMenuOpen(true);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-24 animate-fade-in">
      <section className="overflow-hidden border-2 border-fg bg-[#151713] shadow-neo">
        <div className="flex items-center justify-between border-b border-white/10 bg-[#242720] px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-accent" />
            <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-white/55">OCD Web CLI</span>
          </div>
          <div className="flex items-center gap-1">
            {exitCode !== null && <span className={`mr-2 font-mono text-[9px] ${exitCode === 0 ? "text-accent" : "text-accent-red"}`}>exit {exitCode}</span>}
            <button onClick={() => setMenuOpen((current) => !current)} disabled={running} className={`grid h-7 w-7 place-items-center transition-colors disabled:opacity-25 ${menuOpen ? "text-accent" : "text-white/35 hover:text-white"}`} title={menuOpen ? "Hide command menu" : "Show command menu"}><SlidersHorizontal size={13} /></button>
            <button disabled={!output} onClick={() => navigator.clipboard.writeText(output)} className="grid h-7 w-7 place-items-center text-white/30 hover:text-white disabled:opacity-20" title="Copy output"><Copy size={13} /></button>
          </div>
        </div>

        <div className="relative bg-black p-3">
          <TerminalViewport
            ref={terminalRef}
            focusOnWindow={false}
            onReady={() => setTerminalReady(true)}
            options={{
              convertEol: true,
              cursorBlink: false,
              disableStdin: true,
              theme: {
                background: "#000000",
                foreground: "#d9f99d",
                cursor: "#bef264",
                selectionBackground: "#3f4a2d",
              },
            }}
            style={{ height: "min(72vh, 680px)" }}
          />

          {menuOpen && !running && (
            <div className="absolute left-4 right-4 top-12 z-20 max-w-2xl overflow-hidden border border-white/25 bg-[#121410]/95 shadow-2xl backdrop-blur-sm sm:left-8 sm:right-auto sm:w-[620px]">
              <div className="flex h-10 items-center gap-2 border-b border-white/10 px-3">
                {selectedRoot && <button onClick={back} className="grid h-6 w-6 shrink-0 place-items-center text-white/40 hover:text-accent" title="Back"><ArrowLeft size={13} /></button>}
                <div className="min-w-0 flex-1 truncate font-mono text-[10px] text-white/40">
                  <button onClick={resetToRoot} className="hover:text-accent">ocd</button>
                  {selectedRoot && <><span className="px-1 text-white/20">/</span><span className="text-white/65">{selectedRoot}</span></>}
                  {selected && <><span className="px-1 text-white/20">/</span><span className="text-white/65">{selected.label}</span></>}
                </div>
                <button onClick={() => setMenuOpen(false)} className="grid h-6 w-6 shrink-0 place-items-center text-white/30 hover:text-white" title="Close"><X size={13} /></button>
              </div>

              <div className="max-h-[calc(min(72vh,680px)-4rem)] overflow-y-auto p-3">
                {!selected && (
                  <label className="flex items-center gap-2 border-b border-white/15 px-1 pb-2 text-white/50 focus-within:border-accent">
                    <Search size={13} className="shrink-0" />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} autoFocus placeholder={selectedRoot ? `Filter ${selectedRoot} actions…` : "Filter commands…"} className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-[#eefbd5] outline-none placeholder:text-white/25" />
                  </label>
                )}

                {!selectedRoot && (
                  <div className="mt-2 divide-y divide-white/5 border border-white/10">
                    {roots.map((root) => (
                      <button key={root.name} onClick={() => chooseRoot(root.name)} className="group flex w-full items-center gap-3 bg-[#171a15] px-3 py-2.5 text-left hover:bg-[#242b1c]">
                        <code className="w-24 shrink-0 font-mono text-[11px] font-bold text-accent">{root.name}</code>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-white/40">{root.description}</span>
                        <ChevronRight size={12} className="shrink-0 text-white/20 group-hover:text-accent" />
                      </button>
                    ))}
                    {roots.length === 0 && <TerminalEmpty label="No matching commands" />}
                  </div>
                )}

                {selectedRoot && !selected && (
                  <div className="mt-2">
                    <p className="mb-2 font-mono text-[9px] text-white/30">{rootMeta?.description}</p>
                    <div className="divide-y divide-white/5 border border-white/10">
                      {rootCommands.map((command) => (
                        <button key={command.id} onClick={() => chooseCommand(command)} className="group flex w-full items-center gap-3 bg-[#171a15] px-3 py-2.5 text-left hover:bg-[#242b1c]">
                          <code className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold text-accent">{command.args.slice(1).join(" ") || selectedRoot}</code>
                          {command.danger && <AlertTriangle size={11} className="shrink-0 text-accent-amber" />}
                          {command.unavailableReason && <Ban size={11} className="shrink-0 text-white/30" />}
                          <ChevronRight size={12} className="shrink-0 text-white/20 group-hover:text-accent" />
                        </button>
                      ))}
                      {rootCommands.length === 0 && <TerminalEmpty label="No matching actions" />}
                    </div>
                  </div>
                )}

                {selected && (
                  <div>
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <code className="block truncate font-mono text-[10px] text-accent">$ {preview}</code>
                        <p className="mt-1 text-[10px] leading-4 text-white/35">{selected.description}</p>
                      </div>
                      {selected.danger && <AlertTriangle size={12} className="shrink-0 text-accent-amber" />}
                    </div>

                    {selected.unavailableReason ? (
                      <div className="flex gap-2 border border-white/15 bg-white/5 p-3 text-white/50"><Ban size={14} className="shrink-0" /><p className="text-[10px] leading-4">{selected.unavailableReason}</p></div>
                    ) : (
                      <>
                        {requiredInputs.length > 0 && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{requiredInputs.map((input) => <InputField key={input.key} input={input} value={values[input.key]} options={input.resource ? resources[input.resource] : undefined} resourcesLoading={resourcesLoading || !!(input.resource && contextLoading[input.resource])} onChange={(value) => setValue(input.key, value)} />)}</div>}
                        {optionalInputs.length > 0 && (
                          <div className={`${requiredInputs.length > 0 ? "mt-3 border-t border-white/10 pt-3" : ""}`}>
                            <button onClick={() => setOptionsExpanded((current) => !current)} className="flex items-center gap-2 font-mono text-[9px] font-bold uppercase text-white/35 hover:text-accent"><ChevronDown size={12} className={`transition-transform ${optionsExpanded ? "rotate-180" : ""}`} />{optionalInputs.length} optional</button>
                            {optionsExpanded && <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{optionalInputs.map((input) => <InputField key={input.key} input={input} value={values[input.key]} options={input.resource ? resources[input.resource] : undefined} resourcesLoading={resourcesLoading || !!(input.resource && contextLoading[input.resource])} onChange={(value) => setValue(input.key, value)} />)}</div>}
                          </div>
                        )}
                        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
                          <button disabled={!!validationError} onClick={run} className="inline-flex items-center gap-2 bg-accent px-3 py-2 font-mono text-[9px] font-bold uppercase text-[#151713] disabled:cursor-not-allowed disabled:opacity-35"><Play size={12} fill="currentColor" /> run ↵</button>
                          {selected.inputs.some((input) => input.resource) && <button onClick={() => refreshResources().catch(() => {})} disabled={resourcesLoading} className="inline-flex items-center gap-1 font-mono text-[8px] uppercase text-white/30 hover:text-accent disabled:opacity-30"><RefreshCw size={10} className={resourcesLoading ? "animate-spin" : ""} /> refresh</button>}
                          {validationError && <span className="font-mono text-[9px] text-accent-amber">{validationError}</span>}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {running && <button onClick={() => abortRef.current?.abort()} className="absolute bottom-5 right-5 z-10 inline-flex items-center gap-2 border border-accent-red bg-black/80 px-3 py-2 font-mono text-[9px] font-bold uppercase text-accent-red"><CircleStop size={12} /> stop</button>}
        </div>
      </section>
    </div>
  );
}

function TerminalEmpty({ label }: { label: string }) {
  return <div className="border border-t-0 border-white/10 p-6 text-center font-mono text-[10px] text-white/35">{label}</div>;
}

function InputField({ input, value, options, resourcesLoading, onChange }: { input: WebCliInput; value: string | boolean | string[] | undefined; options?: ResourceOption[]; resourcesLoading: boolean; onChange: (value: string | boolean) => void }) {
  const stringValue = typeof value === "string" ? value : Array.isArray(value) ? value.join("\n") : "";
  const resourceOptions = options ?? [];
  const showResourceId = !input.resource || !["service-type", "service-version", "server-type", "location"].includes(input.resource);
  return (
    <label className={input.repeatable || input.kind === "key-value" ? "sm:col-span-2" : ""}>
      <div className="mb-1 flex items-center gap-1 font-mono text-[10px] font-bold uppercase text-white/75">{input.label}{input.required && <span className="text-accent">*</span>}</div>
      {input.description && <p className="mb-1.5 text-[10px] leading-4 text-white/35">{input.description}</p>}
      {input.kind === "boolean" ? (
        <button type="button" onClick={() => onChange(value !== true)} className={`flex w-full items-center justify-between border px-3 py-2.5 font-mono text-xs transition-colors ${value === true ? "border-accent bg-accent/10 text-accent" : "border-white/20 bg-black/30 text-white/50"}`}><span>{value === true ? "enabled" : "disabled"}</span><span className={`h-4 w-8 border p-0.5 ${value === true ? "border-accent bg-accent/15" : "border-white/20 bg-black/20"}`}><span className={`block h-2 w-2 bg-accent transition-transform ${value === true ? "translate-x-4" : ""}`} /></span></button>
      ) : input.kind === "select" ? (
        <select value={stringValue} onChange={(event) => onChange(event.target.value)} className={inputClass}><option value="">Select…</option>{input.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      ) : input.kind === "resource" ? (
        <>
          <select disabled={resourcesLoading || resourceOptions.length === 0} value={stringValue} onChange={(event) => onChange(event.target.value)} className={inputClass}>
            <option value="">{resourcesLoading ? `Loading ${input.label.toLowerCase()} choices…` : resourceOptions.length === 0 ? `No ${input.label.toLowerCase()} choices available` : `Select ${input.label.toLowerCase()}…`}</option>
            {resourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}{showResourceId ? ` · #${option.value}` : ""}</option>)}
          </select>
          {!resourcesLoading && resourceOptions.length === 0 && <p className="mt-1.5 text-[10px] text-white/35">No accessible {input.label.toLowerCase()} exists for this command.</p>}
        </>
      ) : input.repeatable || input.kind === "key-value" ? (
        <textarea value={stringValue} onChange={(event) => onChange(event.target.value)} rows={3} placeholder={input.placeholder || "One value per line"} className={`${inputClass} resize-y`} />
      ) : (
        <input type={input.kind === "number" ? "number" : "text"} min={input.min} max={input.max} value={stringValue} onChange={(event) => onChange(event.target.value)} placeholder={input.placeholder} className={inputClass} />
      )}
    </label>
  );
}
