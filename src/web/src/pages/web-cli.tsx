import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Ban,
  ChevronRight,
  CircleStop,
  Copy,
  RefreshCw,
} from "lucide-react";
import { get } from "../api/client.ts";
import { useAuth } from "../stores/auth.ts";
import { confirm, portalAnchorRect, showToast } from "../components/ui.tsx";
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

const ROOT_META: Record<string, { label: string; description: string }> = {
  status: { label: "Status", description: "Dashboard overview" },
  apps: { label: "Apps", description: "List deployed applications" },
  app: { label: "App", description: "Inspect and operate an application" },
  logs: { label: "Logs", description: "Read application logs" },
  deploy: { label: "Deploy", description: "Apply manifests with immutable image digests" },
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
    const digest = typeof item.image_digest === "string" && item.image_digest
      ? ` · ${item.image_digest.split("@sha256:").pop()?.slice(0, 10)}`
      : "";
    return [{ value: String(item.id), label: `Deployment #${item.id} · ${item.status ?? "unknown"}${digest}` }];
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

type CompletionItem =
  | { kind: "root"; key: string; value: string; label: string; detail: string }
  | { kind: "command"; key: string; command: WebCliCommand; label: string; detail: string }
  | { kind: "value"; key: string; value: string; label: string; detail?: string }
  | { kind: "input"; key: string; input: WebCliInput; label: string; detail?: string }
  | { kind: "run"; key: string; label: string; detail: string };

function hasValue(value: WebCliValues[string]): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.some((item) => item.trim().length > 0);
}

function inputTokens(input: WebCliInput, value: WebCliValues[string]): string[] {
  if (input.kind === "boolean") return value === true && input.flag ? ["--" + input.flag] : [];
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? input.repeatable ? value.split(/\r?\n/).filter(Boolean) : [value]
      : [];
  return rows.map((row) => input.positional ? row : input.flag ? "--" + input.flag + "=" + row : row);
}

export function WebCliPage() {
  const { token } = useAuth();
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<WebCliValues>({});
  const [resources, setResources] = useState<ResourceOptions>({});
  const [resourcesLoading, setResourcesLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState<Partial<Record<WebCliResource, boolean>>>({});
  const [query, setQuery] = useState("");
  const [activeInputKey, setActiveInputKey] = useState<string | null>(null);
  const [history, setHistory] = useState("");
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: "above" | "below";
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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

  const roots = useMemo(() => {
    const names = Array.from(new Set(WEB_CLI_COMMANDS.map((command) => command.args[0])));
    const filter = query.trim().toLowerCase();
    return names.map((name) => {
      const commands = WEB_CLI_COMMANDS.filter((command) => command.args[0] === name);
      const meta = ROOT_META[name] ?? { label: name, description: `Run ocd ${name}` };
      return { name, commands, ...meta };
    }).filter((root) =>
      !filter || (root.name + " " + root.label + " " + root.description + " " + root.commands.map((command) => command.label).join(" ")).toLowerCase().includes(filter)
    );
  }, [query]);

  const rootCommands = useMemo(() => {
    if (!selectedRoot) return [];
    const filter = query.trim().toLowerCase();
    return WEB_CLI_COMMANDS
      .filter((command) => command.args[0] === selectedRoot)
      .filter((command) => !filter || (command.label + " " + command.description + " " + command.args.join(" ")).toLowerCase().includes(filter));
  }, [selectedRoot, query]);

  const validationError = useMemo(() => {
    if (!selected || selected.unavailableReason) return null;
    try {
      buildWebCliArgv(selected, values);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Complete the required parameters";
    }
  }, [selected, values]);

  const nextRequired = selected?.inputs.find((input) => input.required && !hasValue(values[input.key])) ?? null;
  const activeInput = selected?.inputs.find((input) => input.key === activeInputKey) ?? nextRequired;
  const activeLoading = !!(activeInput?.resource && (resourcesLoading || contextLoading[activeInput.resource]));

  const completions = useMemo<CompletionItem[]>(() => {
    if (!selectedRoot) {
      return roots.map((root) => ({
        kind: "root",
        key: "root:" + root.name,
        value: root.name,
        label: root.name,
        detail: root.description,
      }));
    }
    if (!selected) {
      return rootCommands.map((command) => ({
        kind: "command",
        key: "command:" + command.id,
        command,
        label: command.args.slice(1).join(" ") || command.args[0],
        detail: command.description,
      }));
    }
    if (activeInput) {
      const filter = query.trim().toLowerCase();
      const choices = activeInput.kind === "resource" && activeInput.resource
        ? resources[activeInput.resource] ?? []
        : activeInput.kind === "select"
          ? activeInput.options ?? []
          : activeInput.kind === "boolean"
            ? values[activeInput.key] === true
              ? [{ value: "false", label: "Disable --" + activeInput.flag }]
              : [{ value: "true", label: "Enable --" + activeInput.flag }]
            : [];
      return choices
        .filter((choice) => !filter || (choice.value + " " + choice.label).toLowerCase().includes(filter))
        .map((choice) => ({
          kind: "value",
          key: "value:" + activeInput.key + ":" + choice.value,
          value: choice.value,
          label: choice.label,
          detail: activeInput.kind === "resource" && choice.label !== choice.value ? choice.value : undefined,
        }));
    }
    const filter = query.trim().toLowerCase();
    const optional = selected.inputs
      .filter((input) => !input.required && !hasValue(values[input.key]))
      .filter((input) => !filter || ((input.flag ? "--" + input.flag : input.label) + " " + (input.description || "")).toLowerCase().includes(filter));
    return [
      ...(!validationError && !selected.unavailableReason && (!filter || "run command".includes(filter)) ? [{
        kind: "run" as const,
        key: "run",
        label: "Run command",
        detail: "Enter",
      }] : []),
      ...optional.map((input): CompletionItem => ({
        kind: "input",
        key: "input:" + input.key,
        input,
        label: input.flag ? "--" + input.flag : input.label,
        detail: input.description || input.label,
      })),
    ];
  }, [selectedRoot, selected, activeInput, query, roots, rootCommands, resources, values, validationError]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, running]);

  useEffect(() => {
    setHighlighted(0);
  }, [query, activeInput?.key, selectedId, selectedRoot]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const update = () => {
      const anchor = inputRef.current ?? composerRef.current;
      if (!anchor) return;
      const rect = portalAnchorRect(anchor);
      const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
      // Fixed portals inherit html's zoom, while window.innerWidth/Height do not.
      // Normalize the viewport into the same coordinate space as portalAnchorRect.
      const viewportWidth = window.innerWidth / zoom;
      const viewportHeight = window.innerHeight / zoom;
      const width = Math.min(420, Math.max(280, rect.width), viewportWidth - 24);
      const left = Math.max(12, Math.min(rect.left, viewportWidth - width - 12));
      const roomAbove = rect.top - 12;
      const roomBelow = viewportHeight - rect.bottom - 12;
      const placement = roomBelow < 220 && roomAbove > roomBelow ? "above" : "below";
      const availableHeight = placement === "above" ? roomAbove : roomBelow;
      setMenuPosition({
        top: placement === "above" ? rect.top - 6 : rect.bottom + 6,
        left,
        width,
        maxHeight: Math.min(288, Math.max(48, availableHeight)),
        placement,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [menuOpen, selectedId, selectedRoot, activeInput?.key]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (composerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const chooseRoot = (root: string) => {
    if (running) return;
    const commands = WEB_CLI_COMMANDS.filter((command) => command.args[0] === root);
    setSelectedRoot(root);
    setQuery("");
    if (commands.length === 1) {
      chooseCommand(commands[0]);
      return;
    }
    setSelectedId(null);
    setValues({});
    setActiveInputKey(null);
    setMenuOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const chooseCommand = (command: WebCliCommand) => {
    if (running) return;
    setSelectedRoot(command.args[0]);
    setSelectedId(command.id);
    setValues(defaultsFor(command));
    setActiveInputKey(command.inputs.find((input) => input.required && input.defaultValue === undefined)?.key ?? null);
    setQuery("");
    setMenuOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const setValue = (input: WebCliInput, value: string | boolean) => {
    setValues((current) => {
      const next = { ...current, [input.key]: value };
      if (input.key === "app") {
        delete next.deployment;
        delete next.replica;
      } else if (input.key === "service") {
        delete next.instance;
      }
      return next;
    });
  };

  const resetComposer = (open: boolean) => {
    if (running) return;
    setSelectedRoot(null);
    setSelectedId(null);
    setValues({});
    setQuery("");
    setActiveInputKey(null);
    setMenuOpen(open);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const reopenCommand = () => {
    if (!selectedRoot || running) return;
    const commands = WEB_CLI_COMMANDS.filter((command) => command.args[0] === selectedRoot);
    if (commands.length === 1) {
      resetComposer(true);
      return;
    }
    setSelectedId(null);
    setValues({});
    setActiveInputKey(null);
    setQuery("");
    setMenuOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commitActiveValue = (value: string) => {
    if (!activeInput) return;
    if (!value.trim() && activeInput.kind !== "boolean") return;
    if (activeInput.kind === "boolean") {
      setValue(activeInput, value !== "false");
    } else if (activeInput.repeatable) {
      const current = values[activeInput.key];
      const rows = Array.isArray(current)
        ? current
        : typeof current === "string" && current.trim() ? current.split(/\r?\n/) : [];
      setValue(activeInput, [...rows, value.trim()].join("\n"));
    } else {
      setValue(activeInput, value.trim());
    }
    setActiveInputKey(null);
    setQuery("");
    setMenuOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
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
    setHistory((current) => current + (current && !current.endsWith("\n") ? "\n" : "") + "$ " + commandLine + "\n\n");
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
          } else if (item.type === "stdout" || item.type === "stderr") {
            setHistory((current) => current + stripAnsi(item.data || ""));
          } else if (item.type === "exit") {
            const code = item.code ?? 1;
            setExitCode(code);
            setHistory((current) => current + "\n[" + (item.timed_out ? "timed out" : "exit " + code) + "]\n");
          } else if (item.type === "error") {
            throw new Error(item.error || "CLI execution failed");
          }
        }
        if (done) break;
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setHistory((current) => current + "\n[cancelled]\n");
      } else {
        const message = err instanceof Error ? err.message : "CLI execution failed";
        setHistory((current) => current + "\n[error] " + message + "\n");
        showToast(message, "error");
      }
      setExitCode(1);
    } finally {
      abortRef.current = null;
      setRunning(false);
      setSelectedRoot(null);
      setSelectedId(null);
      setValues({});
      setQuery("");
      setActiveInputKey(null);
    }
  }

  const chooseCompletion = (item: CompletionItem) => {
    if (item.kind === "root") chooseRoot(item.value);
    else if (item.kind === "command") chooseCommand(item.command);
    else if (item.kind === "value") commitActiveValue(item.value);
    else if (item.kind === "input") {
      if (item.input.kind === "boolean") {
        setValue(item.input, true);
        setQuery("");
        setMenuOpen(true);
      } else {
        setActiveInputKey(item.input.key);
        setQuery("");
        setMenuOpen(true);
      }
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      run().catch(() => {});
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && menuOpen && completions.length) {
      event.preventDefault();
      setHighlighted((current) => (current + 1) % completions.length);
      return;
    }
    if (event.key === "ArrowUp" && menuOpen && completions.length) {
      event.preventDefault();
      setHighlighted((current) => (current - 1 + completions.length) % completions.length);
      return;
    }
    if (event.key === "Escape") {
      setMenuOpen(false);
      return;
    }
    if (event.key === "Backspace" && activeInput && !activeInput.required && !query) {
      event.preventDefault();
      setValues((current) => {
        const next = { ...current };
        delete next[activeInput.key];
        return next;
      });
      setActiveInputKey(null);
      return;
    }
    if (event.key === " " && !selected && query.trim()) {
      const exact = completions.find((item) => item.kind === "root"
        ? item.value === query.trim()
        : item.kind === "command" && item.label === query.trim());
      if (exact) {
        event.preventDefault();
        chooseCompletion(exact);
        return;
      }
    }
    if (event.key !== "Tab" && event.key !== "Enter") return;
    if (menuOpen && completions[highlighted] && (!activeInput || !query.trim() || completions[highlighted].kind === "value")) {
      event.preventDefault();
      const completion = completions[highlighted];
      if (event.key === "Tab" && completion.kind === "run") {
        const nextCompletion = completions.find((item) => item.kind !== "run");
        if (nextCompletion) chooseCompletion(nextCompletion);
      } else {
        chooseCompletion(completion);
      }
      return;
    }
    if (activeInput && query.trim()) {
      event.preventDefault();
      commitActiveValue(query);
      return;
    }
    if (event.key === "Enter" && selected && !validationError && !selected.unavailableReason) {
      event.preventDefault();
      run().catch(() => {});
      return;
    }
    if (event.key === "Tab" && menuOpen && completions[highlighted]) {
      event.preventDefault();
      chooseCompletion(completions[highlighted]);
    }
  };

  const completedInputs = selected?.inputs.flatMap((input) =>
    inputTokens(input, values[input.key]).map((token, index) => ({ input, token, key: input.key + ":" + index }))
  ) ?? [];
  const inputPlaceholder = activeInput
    ? activeInput.placeholder || activeInput.label.toLowerCase()
    : selected ? "option" : selectedRoot ? "action" : "command";

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
            <button disabled={!history} onClick={() => navigator.clipboard.writeText(history)} className="grid h-7 w-7 place-items-center text-white/30 hover:text-white disabled:opacity-20" title="Copy history"><Copy size={13} /></button>
          </div>
        </div>

        <div ref={scrollRef} className="overflow-y-auto bg-black p-4 sm:p-5" style={{ height: "min(72vh, 680px)" }}>
          {history && <pre className="mb-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-[#d9f99d]">{history}</pre>}

          {!running && (
            <div ref={composerRef} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[12px] leading-5 text-[#d9f99d]">
              <span className="shrink-0 font-bold text-accent">$</span>
              <button type="button" onClick={() => resetComposer(true)} className="font-mono text-[#d9f99d] underline decoration-white/20 underline-offset-4 hover:text-accent">ocd</button>
              {selected ? selected.args.map((arg, index) => (
                <button key={index + ":" + arg} type="button" onClick={reopenCommand} className="font-mono text-[#d9f99d] underline decoration-white/20 underline-offset-4 hover:text-accent">{arg}</button>
              )) : selectedRoot ? (
                <button type="button" onClick={reopenCommand} className="font-mono text-[#d9f99d] underline decoration-white/20 underline-offset-4 hover:text-accent">{selectedRoot}</button>
              ) : null}
              {completedInputs.map(({ input, token, key }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setActiveInputKey(input.key);
                    setQuery(typeof values[input.key] === "string" && !input.repeatable ? values[input.key] as string : "");
                    setMenuOpen(true);
                    requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                  className={"max-w-full break-all font-mono underline decoration-white/20 underline-offset-4 hover:text-accent " + (activeInput?.key === input.key ? "text-accent" : "text-[#d9f99d]")}
                >
                  {token}
                </button>
              ))}
              {selected?.fixedArgs?.map((arg) => <span key={arg} className="text-white/35">{arg}</span>)}
              <input
                ref={inputRef}
                value={query}
                disabled={running}
                spellCheck={false}
                autoComplete="off"
                aria-label={activeInput ? activeInput.label : "OCD command"}
                placeholder={inputPlaceholder}
                size={Math.max(2, Math.min(36, query.length || inputPlaceholder.length))}
                onFocus={() => { if (query) setMenuOpen(true); }}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (event.target.value || selectedRoot || selected) setMenuOpen(true);
                }}
                onKeyDown={onKeyDown}
                className="min-w-[2ch] max-w-full flex-1 bg-transparent font-mono text-[12px] text-[#eefbd5] caret-accent outline-none placeholder:text-white/20"
              />
            </div>
          )}

          {running && <div className="sticky bottom-0 flex justify-end pt-4"><button onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-2 border border-accent-red bg-black px-3 py-2 font-mono text-[9px] font-bold uppercase text-accent-red"><CircleStop size={12} /> stop</button></div>}
        </div>
      </section>
      {menuOpen && !running && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          style={{
            position: "fixed",
            top: menuPosition.top,
            left: menuPosition.left,
            width: menuPosition.width,
            maxHeight: menuPosition.maxHeight,
            transform: menuPosition.placement === "above" ? "translateY(-100%)" : undefined,
          }}
          className="z-[70] overflow-y-auto border border-white/25 bg-[#121410] shadow-2xl"
        >
          <div className="sticky top-0 z-10 flex items-start gap-2 border-b border-white/10 bg-[#171a15] px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[9px] font-bold text-accent">
                {activeInput ? activeInput.label : selected ? selected.label : selectedRoot ? ROOT_META[selectedRoot]?.label || selectedRoot : "OCD commands"}
              </div>
              <p className="mt-0.5 truncate text-[9px] text-white/35">
                {activeInput?.description || selected?.unavailableReason || selected?.description || (selectedRoot ? ROOT_META[selectedRoot]?.description : "Type to filter · Tab to complete")}
              </p>
            </div>
            {selected?.danger && <AlertTriangle size={11} className="mt-0.5 shrink-0 text-accent-amber" />}
            {selected?.unavailableReason && <Ban size={11} className="mt-0.5 shrink-0 text-white/35" />}
            {selected?.inputs.some((input) => input.resource) && (
              <button type="button" onClick={() => refreshResources().catch(() => {})} disabled={resourcesLoading} className="grid h-5 w-5 shrink-0 place-items-center text-white/30 hover:text-accent disabled:opacity-30" title="Refresh choices">
                <RefreshCw size={10} className={resourcesLoading ? "animate-spin" : ""} />
              </button>
            )}
          </div>
          {activeLoading ? (
            <div className="px-2.5 py-3 font-mono text-[9px] text-white/35">Loading {activeInput?.label.toLowerCase()}…</div>
          ) : completions.length ? completions.map((item, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === highlighted}
              key={item.key}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => chooseCompletion(item)}
              className={"group flex w-full items-center gap-2 border-b border-white/5 px-2.5 py-1.5 text-left last:border-b-0 " + (index === highlighted ? "bg-[#29351d]" : "bg-[#151713] hover:bg-[#20261a]")}
            >
              <code className={"min-w-0 flex-1 truncate font-mono text-[10px] " + (item.kind === "run" ? "font-bold text-accent" : "text-[#eefbd5]")}>{item.label}</code>
              {"detail" in item && item.detail && <span className="max-w-[48%] truncate text-[8px] text-white/30">{item.detail}</span>}
              <ChevronRight size={10} className="shrink-0 text-white/20 group-hover:text-accent" />
            </button>
          )) : (
            <div className="px-2.5 py-3 font-mono text-[9px] text-white/35">
              {activeInput && query ? "Press Enter or Tab to use “" + query + "”" : validationError || "No matching suggestions"}
            </div>
          )}
          <div className="sticky bottom-0 border-t border-white/10 bg-[#171a15] px-2.5 py-1 font-mono text-[8px] text-white/25">
            ↑↓ select · Tab complete · Enter run · Esc close
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
