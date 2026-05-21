import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { get, post, put, del } from "../api/client.ts";
import { Spinner, EmptyState, showToast, confirm, Btn } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import {
  Server, Box, Database, Layers, HardDrive, RefreshCw, Play, Pause,
  RotateCcw, Trash2, ExternalLink, Globe, Plus, Search, Edit3, FileText,
  X, ChevronRight,
} from "lucide-react";

// ---------- types ----------

type GraphData = {
  servers: Array<{ id: number; name: string; status: string; type: string; location: string; ipv4: string }>;
  apps: Array<{ id: number; name: string; status: string; domain: string; environment_id: number | null; volume_id: string | null; desired_replicas: number }>;
  services: Array<{ id: number; name: string; service_type: string; version: string; status: string }>;
  environments: Array<{ id: number; name: string; var_count: number }>;
  volumes: Array<{ id: string; name: string; size_gb: number; location: string }>;
  replicas: Array<{ id: number; app_id: number; server_id: number; status: string }>;
  service_instances: Array<{ id: number; service_id: number; server_id: number; status: string }>;
  service_links: Array<{ service_id: number; environment_id: number; env_prefix: string }>;
};

type NodeKind = "volume" | "server" | "app" | "service" | "env";
type NodeKey = string; // `${kind}:${id}`
const nk = (kind: NodeKind, id: string | number): NodeKey => `${kind}:${id}`;
const parseKey = (k: NodeKey): { kind: NodeKind; id: string } => {
  const i = k.indexOf(":");
  return { kind: k.slice(0, i) as NodeKind, id: k.slice(i + 1) };
};

type LaidOutNode = {
  key: NodeKey;
  kind: NodeKind;
  id: string | number;
  x: number; y: number;
  w: number; h: number;
  label: string;
  sub?: string;
  status?: string;
};

type LaidOutEdge = {
  key: string;
  from: NodeKey;
  to: NodeKey;
  variant: "solid" | "dashed" | "dotted";
  detach?: { kind: "env-app"; env_id: number; app_id: number } | { kind: "env-service"; env_id: number; service_id: number };
};

const APP_OP_KINDS = new Set([
  "restart_app", "pause_app", "unpause_app", "redeploy", "destroy_app", "deploy_app",
]);
const SVC_OP_KINDS = new Set([
  "restart_service", "pause_service", "unpause_service", "destroy_service", "deploy_service",
]);
const APP_OP_LABELS: Record<string, string> = {
  restart: "Restarting app",
  pause: "Pausing app",
  unpause: "Unpausing app",
  redeploy: "Redeploying app",
  delete: "Destroying app",
};
const SVC_OP_LABELS: Record<string, string> = {
  restart: "Restarting service",
  pause: "Pausing service",
  unpause: "Unpausing service",
  delete: "Destroying service",
};

type ServiceCatalogEntry = {
  type: string; label: string; category?: string; icon?: string; color?: string; description?: string;
};

// ---------- layout ----------

const NODE_W = 180;
const NODE_H = 56;
const V_GAP = 24;
const COL_GAP = 280;
const COL_X: Record<NodeKind, number> = {
  volume: 60,
  server: 60 + COL_GAP,
  app: 60 + COL_GAP * 2,
  service: 60 + COL_GAP * 2,
  env: 60 + COL_GAP * 3,
};

const POS_KEY = "graph-positions-v1";
type PosMap = Record<NodeKey, { x: number; y: number }>;

function loadPositions(): PosMap {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function savePositions(p: PosMap) {
  try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch {}
}

function statusColor(status: string | undefined): string {
  switch (status) {
    case "running": case "ready": case "active": return "#22c55e";
    case "paused": case "stopped": return "#9ca3af";
    case "deploying": case "pending": case "starting": case "compensating": return "#3b82f6";
    case "failed": case "error": case "unhealthy": return "#ef4444";
    default: return "#9ca3af";
  }
}

function layoutNodes(data: GraphData, saved: PosMap): LaidOutNode[] {
  const nodes: Record<NodeKind, LaidOutNode[]> = { volume: [], server: [], app: [], service: [], env: [] };

  for (const v of data.volumes) {
    nodes.volume.push({ key: nk("volume", v.id), kind: "volume", id: v.id, x: 0, y: 0, w: NODE_W, h: NODE_H, label: v.name, sub: `${v.size_gb}GB · ${v.location}` });
  }
  for (const s of data.servers) {
    nodes.server.push({ key: nk("server", s.id), kind: "server", id: s.id, x: 0, y: 0, w: NODE_W, h: NODE_H, label: s.name, sub: `${s.type} · ${s.location}`, status: s.status });
  }
  for (const a of data.apps) {
    nodes.app.push({ key: nk("app", a.id), kind: "app", id: a.id, x: 0, y: 0, w: NODE_W, h: NODE_H, label: a.name, sub: a.domain || `${a.desired_replicas}× replica${a.desired_replicas === 1 ? "" : "s"}`, status: a.status });
  }
  for (const s of data.services) {
    nodes.service.push({ key: nk("service", s.id), kind: "service", id: s.id, x: 0, y: 0, w: NODE_W, h: NODE_H, label: s.name, sub: `${s.service_type} ${s.version}`, status: s.status });
  }
  for (const e of data.environments) {
    nodes.env.push({ key: nk("env", e.id), kind: "env", id: e.id, x: 0, y: 0, w: NODE_W, h: NODE_H, label: e.name, sub: `${e.var_count} var${e.var_count === 1 ? "" : "s"}` });
  }

  const adj = new Map<NodeKey, NodeKey[]>();
  const addAdj = (a: NodeKey, b: NodeKey) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  };
  const seen = new Set<string>();
  for (const r of data.replicas) {
    const k = `r:${r.server_id}:${r.app_id}`;
    if (seen.has(k)) continue; seen.add(k);
    addAdj(nk("server", r.server_id), nk("app", r.app_id));
  }
  for (const i of data.service_instances) {
    const k = `i:${i.server_id}:${i.service_id}`;
    if (seen.has(k)) continue; seen.add(k);
    addAdj(nk("server", i.server_id), nk("service", i.service_id));
  }
  for (const a of data.apps) {
    if (a.environment_id != null) addAdj(nk("app", a.id), nk("env", a.environment_id));
    if (a.volume_id) addAdj(nk("app", a.id), nk("volume", a.volume_id));
  }
  for (const l of data.service_links) {
    addAdj(nk("service", l.service_id), nk("env", l.environment_id));
  }

  const ySlot = (i: number, yStart = 60) => yStart + i * (NODE_H + V_GAP);
  nodes.server.sort((a, b) => a.label.localeCompare(b.label));
  nodes.server.forEach((n, i) => { n.x = COL_X.server; n.y = ySlot(i); });

  const placedY = new Map<NodeKey, number>();
  for (const n of nodes.server) placedY.set(n.key, n.y);

  const meanNeighborY = (key: NodeKey): number => {
    const ns = adj.get(key) || [];
    const ys: number[] = [];
    for (const nk of ns) {
      const y = placedY.get(nk);
      if (y != null) ys.push(y);
    }
    if (ys.length === 0) return Number.POSITIVE_INFINITY;
    return ys.reduce((s, v) => s + v, 0) / ys.length;
  };

  const placeCol = (col: LaidOutNode[], x: number, yStart = 60) => {
    col.sort((a, b) => {
      const ma = meanNeighborY(a.key);
      const mb = meanNeighborY(b.key);
      if (ma === mb) return a.label.localeCompare(b.label);
      return ma - mb;
    });
    col.forEach((n, i) => { n.x = x; n.y = ySlot(i, yStart); placedY.set(n.key, n.y); });
  };

  const middle = [...nodes.app, ...nodes.service];
  placeCol(middle, COL_X.app);
  placeCol(nodes.volume, COL_X.volume);
  placeCol(nodes.env, COL_X.env);
  placeCol(middle, COL_X.app);

  const out: LaidOutNode[] = [
    ...nodes.volume, ...nodes.server, ...nodes.app, ...nodes.service, ...nodes.env,
  ];

  for (const n of out) {
    const sv = saved[n.key];
    if (sv) { n.x = sv.x; n.y = sv.y; }
  }
  return out;
}

function buildEdges(data: GraphData): LaidOutEdge[] {
  const out: LaidOutEdge[] = [];
  const serverApp = new Set<string>();
  for (const r of data.replicas) {
    const key = `${r.server_id}:${r.app_id}`;
    if (serverApp.has(key)) continue;
    serverApp.add(key);
    out.push({ key: `repl-${key}`, from: nk("server", r.server_id), to: nk("app", r.app_id), variant: "solid" });
  }
  const serverSvc = new Set<string>();
  for (const i of data.service_instances) {
    const key = `${i.server_id}:${i.service_id}`;
    if (serverSvc.has(key)) continue;
    serverSvc.add(key);
    out.push({ key: `inst-${key}`, from: nk("server", i.server_id), to: nk("service", i.service_id), variant: "solid" });
  }
  for (const a of data.apps) {
    if (a.environment_id != null) {
      out.push({
        key: `app-env-${a.id}-${a.environment_id}`,
        from: nk("app", a.id),
        to: nk("env", a.environment_id),
        variant: "dashed",
        detach: { kind: "env-app", env_id: a.environment_id, app_id: a.id },
      });
    }
  }
  for (const l of data.service_links) {
    out.push({
      key: `svc-env-${l.service_id}-${l.environment_id}`,
      from: nk("service", l.service_id),
      to: nk("env", l.environment_id),
      variant: "dashed",
      detach: { kind: "env-service", env_id: l.environment_id, service_id: l.service_id },
    });
  }
  for (const a of data.apps) {
    if (a.volume_id) {
      out.push({ key: `app-vol-${a.id}`, from: nk("app", a.id), to: nk("volume", a.volume_id), variant: "dotted" });
    }
  }
  return out;
}

function edgePath(from: { x: number; y: number; w: number; h: number }, to: { x: number; y: number; w: number; h: number }) {
  const fRight = from.x + from.w, fLeft = from.x;
  const tRight = to.x + to.w, tLeft = to.x;
  const fy = from.y + from.h / 2;
  const ty = to.y + to.h / 2;
  let sx: number, ex: number;
  if (to.x >= from.x) { sx = fRight; ex = tLeft; }
  else { sx = fLeft; ex = tRight; }
  const dx = Math.abs(ex - sx);
  const c = Math.max(40, dx * 0.5);
  const c1x = sx + (ex > sx ? c : -c);
  const c2x = ex + (ex > sx ? -c : c);
  return `M ${sx} ${fy} C ${c1x} ${fy}, ${c2x} ${ty}, ${ex} ${ty}`;
}

const ICONS: Record<NodeKind, typeof Server> = {
  volume: HardDrive,
  server: Server,
  app: Box,
  service: Database,
  env: Layers,
};

// Which target kinds is a drag from this source kind allowed to land on?
const VALID_TARGETS: Record<NodeKind, Set<NodeKind>> = {
  app:     new Set<NodeKind>(["env", "volume"]),
  service: new Set<NodeKind>(["env"]),
  env:     new Set<NodeKind>(["app", "service"]),
  volume:  new Set<NodeKind>(["app"]),
  server:  new Set<NodeKind>(), // read-only
};

// ---------- main page ----------

type ContextMenuState = { x: number; y: number; node: LaidOutNode } | null;
type CreateMenuState = { x: number; y: number } | null;
type RenameState = { key: NodeKey; value: string } | null;

export function GraphPage() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<PosMap>(() => loadPositions());
  const [selected, setSelected] = useState<NodeKey | null>(null);
  const [hovered, setHovered] = useState<NodeKey | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [createMenu, setCreateMenu] = useState<CreateMenuState>(null);
  const [renameState, setRenameState] = useState<RenameState>(null);
  const [search, setSearch] = useState("");
  const [catalog, setCatalog] = useState<ServiceCatalogEntry[]>([]);

  // viewBox state for pan/zoom
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 1200, h: 700 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const newBtnRef = useRef<HTMLDivElement | null>(null);

  const dragState = useRef<
    | { mode: "node"; key: NodeKey; offX: number; offY: number; moved: boolean }
    | { mode: "pan"; startCX: number; startCY: number; vbX: number; vbY: number }
    | { mode: "link"; fromKey: NodeKey; fromKind: NodeKind; cur: { x: number; y: number } }
    | null
  >(null);
  const [linkCursor, setLinkCursor] = useState<{ x: number; y: number } | null>(null);
  const [linkHover, setLinkHover] = useState<NodeKey | null>(null);
  // Force a re-render while dragging a link so paint reflects dragState.current.
  const [, setLinkTick] = useState(0);

  const ops = useActiveOperations(
    (op) => APP_OP_KINDS.has(op.kind) || SVC_OP_KINDS.has(op.kind),
    { rehydrateToasts: true },
  );

  const load = useCallback(async () => {
    try {
      const res = (await get("/api/graph")) as GraphData;
      setData(res);
    } catch (err: any) {
      showToast(err?.message || "Failed to load graph", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load service catalog once for the create-service picker.
  useEffect(() => {
    get("/api/services/catalog")
      .then((c) => setCatalog((c as ServiceCatalogEntry[]) || []))
      .catch(() => { /* picker still works, just no quick-add tiles */ });
  }, []);

  const activeSig = ops.active.map((o) => `${o.id}:${o.status}`).join(",");
  useEffect(() => { if (!loading) load(); }, [activeSig]);

  // Close menus on escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setCtxMenu(null);
        setCreateMenu(null);
        setRenameState(null);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      setViewBox((vb) => ({ ...vb, w: width, h: Math.max(500, height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = useMemo(() => data ? layoutNodes(data, positions) : [], [data, positions]);
  const edges = useMemo(() => data ? buildEdges(data) : [], [data]);
  const nodeMap = useMemo(() => {
    const m = new Map<NodeKey, LaidOutNode>();
    for (const n of nodes) m.set(n.key, n);
    return m;
  }, [nodes]);

  // Derive in-flight node keys from active ops via resource_keys. Resource
  // keys look like "app:42" / "service:7" — match those, ignoring any other
  // shapes (e.g. "service:create:foo" before the id is assigned).
  const busyKeys = useMemo(() => {
    const s = new Set<NodeKey>();
    for (const op of ops.active) {
      for (const rk of op.resource_keys || []) {
        const parts = rk.split(":");
        if (parts.length === 2 && (parts[0] === "app" || parts[0] === "service" || parts[0] === "env")) {
          s.add(rk);
        }
      }
    }
    return s;
  }, [ops.active]);

  // Search matches (case-insensitive substring on label or kind).
  const matchKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const s = new Set<NodeKey>();
    for (const n of nodes) {
      if (n.label.toLowerCase().includes(q) || n.kind.includes(q) || (n.sub || "").toLowerCase().includes(q)) {
        s.add(n.key);
      }
    }
    return s;
  }, [search, nodes]);

  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const inv = ctm.inverse();
    const r = pt.matrixTransform(inv);
    return { x: r.x, y: r.y };
  };

  // --- node drag ---
  const onNodeMouseDown = (e: React.MouseEvent, n: LaidOutNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setCtxMenu(null); setCreateMenu(null);
    const p = toSvg(e.clientX, e.clientY);
    dragState.current = { mode: "node", key: n.key, offX: p.x - n.x, offY: p.y - n.y, moved: false };
  };

  // --- right-click context menu ---
  const onNodeContextMenu = (e: React.MouseEvent, n: LaidOutNode) => {
    e.preventDefault();
    e.stopPropagation();
    setCreateMenu(null);
    setCtxMenu({ x: e.clientX, y: e.clientY, node: n });
  };

  // --- handle (drag-to-connect) ---
  const onHandleDown = (e: React.MouseEvent, n: LaidOutNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setCtxMenu(null); setCreateMenu(null);
    if (VALID_TARGETS[n.kind].size === 0) return;
    const p = toSvg(e.clientX, e.clientY);
    dragState.current = { mode: "link", fromKey: n.key, fromKind: n.kind, cur: p };
    setLinkCursor(p);
    setLinkTick((t) => t + 1);
  };

  // --- pan (mousedown on empty svg) ---
  const onSvgMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setCtxMenu(null); setCreateMenu(null);
    dragState.current = { mode: "pan", startCX: e.clientX, startCY: e.clientY, vbX: viewBox.x, vbY: viewBox.y };
  };

  // --- right-click empty canvas → create menu ---
  const onSvgContextMenu = (e: React.MouseEvent) => {
    // Only fire when the event target is the svg/grid itself, not a child node.
    const t = e.target as SVGElement;
    if (t.tagName !== "svg" && t.tagName !== "rect") return;
    if (t.tagName === "rect" && t.getAttribute("fill") !== "url(#grid)") return;
    e.preventDefault();
    setCtxMenu(null);
    setCreateMenu({ x: e.clientX, y: e.clientY });
  };

  const onSvgMouseMove = (e: React.MouseEvent) => {
    const ds = dragState.current;
    if (!ds) return;
    if (ds.mode === "node") {
      const p = toSvg(e.clientX, e.clientY);
      const nx = p.x - ds.offX, ny = p.y - ds.offY;
      ds.moved = true;
      setPositions((prev) => ({ ...prev, [ds.key]: { x: nx, y: ny } }));
    } else if (ds.mode === "pan") {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = viewBox.w / rect.width;
      const scaleY = viewBox.h / rect.height;
      const dx = (e.clientX - ds.startCX) * scaleX;
      const dy = (e.clientY - ds.startCY) * scaleY;
      setViewBox((vb) => ({ ...vb, x: ds.vbX - dx, y: ds.vbY - dy }));
    } else if (ds.mode === "link") {
      const p = toSvg(e.clientX, e.clientY);
      ds.cur = p;
      setLinkCursor(p);
    }
  };

  const onSvgMouseUp = async (e: React.MouseEvent) => {
    const ds = dragState.current;
    dragState.current = null;
    if (!ds) return;
    if (ds.mode === "node") {
      if (ds.moved) {
        setPositions((prev) => { savePositions(prev); return prev; });
      } else {
        setSelected((s) => s === ds.key ? null : ds.key);
      }
    } else if (ds.mode === "link") {
      setLinkCursor(null);
      const target = linkHover;
      setLinkHover(null);
      if (target) await commitLink(ds.fromKey, ds.fromKind, target);
    }
    void e;
  };

  const commitLink = async (fromKey: NodeKey, fromKind: NodeKind, toKey: NodeKey) => {
    const to = nodeMap.get(toKey);
    if (!to) return;
    if (!VALID_TARGETS[fromKind].has(to.kind)) return;

    const f = parseKey(fromKey);
    // Normalize: env→{app,service} or {app,service}→env both reduce to env+other.
    const envSide = fromKind === "env" ? f : (to.kind === "env" ? { kind: "env" as const, id: String(to.id) } : null);
    const otherSide = fromKind === "env" ? { kind: to.kind, id: String(to.id) } : (to.kind === "env" ? f : null);

    if (envSide && otherSide) {
      const envId = Number(envSide.id);
      if (otherSide.kind === "app") return attachEnvToApp(envId, Number(otherSide.id));
      if (otherSide.kind === "service") return injectEnvIntoService(envId, Number(otherSide.id));
    }

    // App↔Volume in either direction.
    const volSide = fromKind === "volume" ? f : (to.kind === "volume" ? { kind: "volume" as const, id: String(to.id) } : null);
    const appSide = fromKind === "app" ? f : (to.kind === "app" ? { kind: "app" as const, id: String(to.id) } : null);
    if (volSide && appSide) {
      return attachVolumeToApp(volSide.id, Number(appSide.id));
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width;
    const my = (e.clientY - rect.top) / rect.height;
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setViewBox((vb) => {
      const newW = Math.min(8000, Math.max(200, vb.w * factor));
      const newH = Math.min(8000, Math.max(150, vb.h * factor));
      const dx = (newW - vb.w) * mx;
      const dy = (newH - vb.h) * my;
      return { x: vb.x - dx, y: vb.y - dy, w: newW, h: newH };
    });
  };

  const onNodeMouseEnter = (key: NodeKey) => {
    setHovered(key);
    if (dragState.current?.mode === "link") {
      const n = nodeMap.get(key);
      if (n && VALID_TARGETS[dragState.current.fromKind].has(n.kind)) setLinkHover(key);
    }
  };
  const onNodeMouseLeave = (key: NodeKey) => {
    if (hovered === key) setHovered(null);
    if (linkHover === key) setLinkHover(null);
  };

  // ---------- actions ----------

  const appAction = async (action: string, appId: number) => {
    const key = `app-${action}-${appId}`;
    setActionLoading(key);
    try {
      const res = action === "delete"
        ? await del(`/api/apps/${appId}`) as { op_id?: number }
        : await post(`/api/apps/${appId}/${action}`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, APP_OP_LABELS[action] || "Operation");
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const svcAction = async (action: string, svcId: number) => {
    const key = `svc-${action}-${svcId}`;
    setActionLoading(key);
    try {
      const res = action === "delete"
        ? await del(`/api/services/${svcId}`) as { op_id?: number }
        : await post(`/api/services/${svcId}/${action}`) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, SVC_OP_LABELS[action] || "Operation");
        ops.track(res.op_id);
      }
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const attachEnvToApp = async (envId: number, appId: number) => {
    try {
      const res = await post(`/api/environments/${envId}/apps`, { app_id: appId }) as { op_id?: number };
      if (res?.op_id) {
        trackOperationInToast(res.op_id, "Attaching env");
        ops.track(res.op_id);
      }
      showToast("Environment attached", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Attach failed", "error");
    }
  };

  const detachEnvFromApp = async (envId: number, appId: number) => {
    try {
      await post(`/api/environments/${envId}/apps/detach`, { app_id: appId });
      showToast("Environment detached", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Detach failed", "error");
    }
  };

  const injectEnvIntoService = async (envId: number, svcId: number) => {
    const prefix = window.prompt("Env var prefix (e.g. DATABASE, CACHE):", "DATABASE");
    if (!prefix) return;
    try {
      await post(`/api/services/${svcId}/inject/${envId}`, { env_prefix: prefix });
      showToast("Service injected", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Inject failed", "error");
    }
  };

  const uninjectEnvFromService = async (envId: number, svcId: number) => {
    try {
      await del(`/api/services/${svcId}/inject/${envId}`);
      showToast("Service uninjected", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Uninject failed", "error");
    }
  };

  const attachVolumeToApp = async (volumeId: string, appId: number) => {
    try {
      const r = await post(`/api/volumes/attach-existing`, { app_id: appId, volume_id: volumeId }) as { ok?: boolean; error?: string };
      if (r?.ok === false) { showToast(r.error || "Attach failed", "error"); return; }
      showToast("Volume attached", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Attach failed", "error");
    }
  };

  const detachVolumeFromApp = async (appId: number) => {
    try {
      const r = await post(`/api/volumes/detach`, { app_id: appId }) as { ok?: boolean; error?: string };
      if (r?.ok === false) { showToast(r.error || "Detach failed", "error"); return; }
      showToast("Volume detached", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Detach failed", "error");
    }
  };

  const commitRename = async () => {
    const rn = renameState;
    if (!rn) return;
    const newName = rn.value.trim();
    setRenameState(null);
    if (!newName) return;
    const { kind, id } = parseKey(rn.key);
    try {
      if (kind === "app") {
        await put(`/api/apps/${id}/rename`, { name: newName });
      } else if (kind === "env") {
        await put(`/api/environments/${id}`, { name: newName });
      } else {
        return; // not renameable
      }
      showToast("Renamed", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Rename failed", "error");
    }
  };

  const deleteEnv = async (id: number, name: string) => {
    if (!await confirm("Delete Environment", `Delete "${name}"? Detach from any apps/services first.`, true)) return;
    try {
      const r = await del(`/api/environments/${id}`) as { ok?: boolean; error?: string };
      if (r?.ok === false) { showToast(r.error || "Delete failed", "error"); return; }
      showToast("Environment deleted", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Delete failed", "error");
    }
  };

  const createEnvironment = async () => {
    const name = window.prompt("Environment name:", "");
    if (!name?.trim()) return;
    try {
      await post(`/api/environments`, { name: name.trim(), env_vars: [] });
      showToast("Environment created", "success");
      load();
    } catch (err: any) {
      showToast(err.message || "Create failed", "error");
    }
  };

  const resetLayout = () => {
    localStorage.removeItem(POS_KEY);
    setPositions({});
    showToast("Layout reset", "info");
  };

  const fitView = (subset?: Set<NodeKey>) => {
    const ns = subset ? nodes.filter((n) => subset.has(n.key)) : nodes;
    if (ns.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    const pad = 60;
    setViewBox({ x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 });
  };

  if (loading) return <div className="flex justify-center py-20"><Spinner /></div>;
  if (!data) return null;

  const isEmpty =
    data.servers.length === 0 && data.apps.length === 0 && data.services.length === 0
    && data.environments.length === 0 && data.volumes.length === 0;

  const relatedKeys = new Set<NodeKey>();
  const relatedEdges = new Set<string>();
  if (hovered) {
    relatedKeys.add(hovered);
    for (const e of edges) {
      if (e.from === hovered || e.to === hovered) {
        relatedEdges.add(e.key);
        relatedKeys.add(e.from);
        relatedKeys.add(e.to);
      }
    }
  }
  const busyEdges = new Set<string>();
  for (const e of edges) {
    if (busyKeys.has(e.from) || busyKeys.has(e.to)) busyEdges.add(e.key);
  }

  const selectedNode = selected ? nodeMap.get(selected) ?? null : null;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 animate-fade-in">
      <style>{`
        @keyframes graph-pulse {
          0%, 100% { stroke-opacity: 1; stroke-width: 2; }
          50% { stroke-opacity: 0.4; stroke-width: 3.5; }
        }
        @keyframes graph-dash {
          to { stroke-dashoffset: -16; }
        }
        .graph-busy-node { animation: graph-pulse 1.4s ease-in-out infinite; }
        .graph-busy-edge { animation: graph-dash 0.8s linear infinite; }
      `}</style>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="font-mono font-bold text-sm text-fg uppercase">Graph</h1>
          <p className="text-[10px] text-muted font-mono mt-0.5">
            {data.servers.length} server · {data.apps.length} app · {data.services.length} service · {data.environments.length} env · {data.volumes.length} volume
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
            <input
              type="text"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matchKeys && matchKeys.size > 0) fitView(matchKeys);
                if (e.key === "Escape") setSearch("");
              }}
              className="font-mono text-[10px] border-2 border-fg pl-6 pr-2 py-1 w-40 focus:outline-none focus:bg-yellow-50"
            />
          </div>
          <div ref={newBtnRef}>
            <Btn
              onClick={() => {
                const r = newBtnRef.current?.getBoundingClientRect();
                setCreateMenu({ x: r ? r.left : 200, y: r ? r.bottom + 4 : 100 });
              }}
              variant="primary"
            ><Plus size={13} /> New</Btn>
          </div>
          <Btn onClick={load} variant="ghost"><RefreshCw size={13} /> Refresh</Btn>
          <Btn onClick={() => fitView()} variant="ghost">Fit</Btn>
          <Btn onClick={resetLayout} variant="ghost">Reset</Btn>
        </div>
      </div>

      {isEmpty ? (
        <div className="border-2 border-fg bg-white p-8 shadow-neo">
          <EmptyState message="Nothing deployed yet. Use New to deploy your first app or service." icon={Box} />
          <div className="mt-4 flex justify-center gap-2">
            <Btn variant="primary" onClick={() => { window.location.hash = "#/deploy"; }}><Box size={13} /> Deploy App</Btn>
            <Btn variant="default" onClick={() => { window.location.hash = "#/deploy-service"; }}><Database size={13} /> Add Service</Btn>
            <Btn variant="default" onClick={createEnvironment}><Layers size={13} /> Create Env</Btn>
          </div>
        </div>
      ) : (
        <div
          className="relative border-2 border-fg bg-white shadow-neo overflow-hidden"
          style={{ height: "calc(100vh - 160px)", minHeight: 500 }}
        >
          <svg
            ref={svgRef}
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            className="w-full h-full cursor-grab active:cursor-grabbing select-none"
            onMouseDown={onSvgMouseDown}
            onMouseMove={onSvgMouseMove}
            onMouseUp={onSvgMouseUp}
            onMouseLeave={onSvgMouseUp}
            onContextMenu={onSvgContextMenu}
            onWheel={onWheel}
          >
            <defs>
              <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#f3f4f6" strokeWidth="1" />
              </pattern>
            </defs>
            <rect
              x={viewBox.x - 5000}
              y={viewBox.y - 5000}
              width={viewBox.w + 10000}
              height={viewBox.h + 10000}
              fill="url(#grid)"
            />

            {/* Edges */}
            <g>
              {edges.map((edge) => {
                const a = nodeMap.get(edge.from);
                const b = nodeMap.get(edge.to);
                if (!a || !b) return null;
                const d = edgePath(a, b);
                const dim = hovered && !relatedEdges.has(edge.key);
                const busy = busyEdges.has(edge.key);
                const stroke = busy ? "#3b82f6" : "#111";
                const dash = busy
                  ? "6 4"
                  : edge.variant === "dashed" ? "6 4"
                  : edge.variant === "dotted" ? "2 3"
                  : undefined;
                const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
                const my = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
                return (
                  <g key={edge.key} opacity={dim ? 0.15 : 1}>
                    <path
                      d={d} fill="none" stroke={stroke}
                      strokeWidth={busy ? 2 : 1.5}
                      strokeDasharray={dash}
                      className={busy ? "graph-busy-edge" : undefined}
                    />
                    {edge.detach && hovered && relatedEdges.has(edge.key) && (
                      <g
                        style={{ cursor: "pointer" }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (edge.detach!.kind === "env-app") {
                            detachEnvFromApp(edge.detach!.env_id, edge.detach!.app_id);
                          } else {
                            uninjectEnvFromService(edge.detach!.env_id, edge.detach!.service_id);
                          }
                        }}
                      >
                        <circle cx={mx} cy={my} r={9} fill="#fff" stroke="#111" strokeWidth={1.5} />
                        <line x1={mx - 3} y1={my - 3} x2={mx + 3} y2={my + 3} stroke="#dc2626" strokeWidth={1.5} />
                        <line x1={mx + 3} y1={my - 3} x2={mx - 3} y2={my + 3} stroke="#dc2626" strokeWidth={1.5} />
                      </g>
                    )}
                  </g>
                );
              })}

              {/* live linking line */}
              {dragState.current?.mode === "link" && linkCursor && (() => {
                const src = nodeMap.get(dragState.current.fromKey);
                if (!src) return null;
                const sx = src.x + src.w; // pulled from right edge of node
                const sy = src.y + src.h / 2;
                return <line x1={sx} y1={sy} x2={linkCursor.x} y2={linkCursor.y} stroke="#22c55e" strokeWidth={2} strokeDasharray="6 4" pointerEvents="none" />;
              })()}
            </g>

            {/* Nodes */}
            <g>
              {nodes.map((n) => {
                const dim = hovered && !relatedKeys.has(n.key);
                const isLinkTarget = linkHover === n.key;
                const isSelected = selected === n.key;
                const isMatch = matchKeys?.has(n.key);
                const isBusy = busyKeys.has(n.key);
                const isRenaming = renameState?.key === n.key;
                const dragging = dragState.current?.mode === "link";
                const isValidTarget = dragging && dragging && nodeMap.get((dragState.current as any).fromKey)
                  && VALID_TARGETS[(dragState.current as any).fromKind as NodeKind].has(n.kind)
                  && n.key !== (dragState.current as any).fromKey;
                const fill = n.kind === "env" ? "#fffbeb"
                  : n.kind === "volume" ? "#eff6ff"
                  : n.kind === "server" ? "#f5f3ff"
                  : "#ffffff";
                const stroke = isLinkTarget ? "#22c55e"
                  : isSelected ? "#3b82f6"
                  : isMatch ? "#eab308"
                  : "#111";
                const strokeWidth = isLinkTarget || isSelected || isMatch ? 3 : 2;
                return (
                  <g
                    key={n.key}
                    transform={`translate(${n.x},${n.y})`}
                    opacity={dim ? 0.3 : (matchKeys && !isMatch ? 0.4 : 1)}
                    style={{ cursor: "grab" }}
                    onMouseDown={(e) => onNodeMouseDown(e, n)}
                    onMouseEnter={() => onNodeMouseEnter(n.key)}
                    onMouseLeave={() => onNodeMouseLeave(n.key)}
                    onContextMenu={(e) => onNodeContextMenu(e, n)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (n.kind === "app" || n.kind === "env") {
                        setRenameState({ key: n.key, value: n.label });
                      }
                    }}
                  >
                    <rect x={3} y={3} width={n.w} height={n.h} fill="#111" />
                    <rect
                      x={0} y={0} width={n.w} height={n.h}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      className={isBusy ? "graph-busy-node" : undefined}
                    />
                    {/* highlight ring when this is a valid drop target during a link drag */}
                    {isValidTarget && (
                      <rect x={-4} y={-4} width={n.w + 8} height={n.h + 8} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
                    )}
                    {/* status dot */}
                    {n.status && (
                      <circle cx={n.w - 12} cy={12} r={4} fill={statusColor(n.status)} stroke="#111" strokeWidth={1} />
                    )}
                    {/* kind label */}
                    <text x={10} y={16} fontFamily="ui-monospace, monospace" fontSize="8" fontWeight="700" fill="#6b7280" style={{ textTransform: "uppercase" }}>{n.kind}</text>
                    {/* name */}
                    {!isRenaming && (
                      <text x={10} y={34} fontFamily="ui-monospace, monospace" fontSize="11" fontWeight="700" fill="#111">{truncate(n.label, 22)}</text>
                    )}
                    {/* sub */}
                    {n.sub && !isRenaming && (
                      <text x={10} y={48} fontFamily="ui-monospace, monospace" fontSize="9" fill="#6b7280">{truncate(n.sub, 26)}</text>
                    )}
                    {/* connection handle */}
                    {VALID_TARGETS[n.kind].size > 0 && (
                      <g
                        style={{ cursor: "crosshair" }}
                        onMouseDown={(e) => onHandleDown(e, n)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <circle
                          cx={n.w + 2} cy={n.h / 2} r={9}
                          fill={n.kind === "env" ? "#fef3c7" : n.kind === "volume" ? "#dbeafe" : "#dcfce7"}
                          stroke="#111" strokeWidth={2}
                        />
                        <line x1={n.w - 2} y1={n.h / 2} x2={n.w + 6} y2={n.h / 2} stroke="#111" strokeWidth={1.5} />
                        <line x1={n.w + 2} y1={n.h / 2 - 4} x2={n.w + 2} y2={n.h / 2 + 4} stroke="#111" strokeWidth={1.5} />
                      </g>
                    )}
                    {/* inline rename input */}
                    {isRenaming && (
                      <foreignObject x={6} y={20} width={n.w - 12} height={28}>
                        <input
                          autoFocus
                          value={renameState!.value}
                          onChange={(e) => setRenameState({ key: n.key, value: e.target.value })}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenameState(null);
                            e.stopPropagation();
                          }}
                          onMouseDown={(e) => e.stopPropagation()}
                          className="w-full font-mono text-[11px] font-bold border-2 border-fg px-1 py-0.5 bg-yellow-50"
                          style={{ outline: "none" }}
                        />
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          {/* Selected node popover */}
          {selectedNode && data && (
            <NodePopover
              node={selectedNode}
              data={data}
              viewBox={viewBox}
              svgRef={svgRef}
              actionLoading={actionLoading}
              busy={busyKeys.has(selectedNode.key)}
              onClose={() => setSelected(null)}
              onAppAction={appAction}
              onSvcAction={svcAction}
            />
          )}

          {/* Right-click context menu */}
          {ctxMenu && (
            <ContextMenu
              node={ctxMenu.node}
              data={data}
              svgRef={svgRef}
              clientX={ctxMenu.x}
              clientY={ctxMenu.y}
              onClose={() => setCtxMenu(null)}
              onRename={(key, label) => setRenameState({ key, value: label })}
              onAppAction={appAction}
              onSvcAction={svcAction}
              onDeleteEnv={deleteEnv}
              onDetachVolume={detachVolumeFromApp}
            />
          )}

          {/* New: empty-canvas create menu / + button picker */}
          {createMenu && (
            <CreateMenu
              clientX={createMenu.x}
              clientY={createMenu.y}
              svgRef={svgRef}
              catalog={catalog}
              onClose={() => setCreateMenu(null)}
              onCreateEnv={createEnvironment}
            />
          )}

          {/* Minimap */}
          <Minimap
            nodes={nodes}
            edges={edges}
            viewBox={viewBox}
            onPan={(cx, cy) => setViewBox((vb) => ({ ...vb, x: cx - vb.w / 2, y: cy - vb.h / 2 }))}
          />

          {/* Legend */}
          <div className="absolute bottom-2 right-2 bg-white border-2 border-fg p-2 font-mono text-[8px] uppercase space-y-1 shadow-neo">
            <div className="flex items-center gap-2"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#111" strokeWidth="1.5" /></svg>runs on</div>
            <div className="flex items-center gap-2"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#111" strokeWidth="1.5" strokeDasharray="6 4" /></svg>env link</div>
            <div className="flex items-center gap-2"><svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#111" strokeWidth="1.5" strokeDasharray="2 3" /></svg>volume</div>
            <div className="text-[7px] text-muted normal-case pt-1 border-t border-fg/10">drag handle → target · right-click for actions · double-click to rename</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- minimap ----------

function Minimap({
  nodes, edges, viewBox, onPan,
}: {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  viewBox: { x: number; y: number; w: number; h: number };
  onPan: (cx: number, cy: number) => void;
}) {
  const W = 200, H = 130, PAD = 8;
  if (nodes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  minX = Math.min(minX, viewBox.x);
  minY = Math.min(minY, viewBox.y);
  maxX = Math.max(maxX, viewBox.x + viewBox.w);
  maxY = Math.max(maxY, viewBox.y + viewBox.h);

  const span = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((W - PAD * 2) / span, (H - PAD * 2) / spanY);
  const ox = PAD - minX * scale;
  const oy = PAD - minY * scale;
  const nodeMap = new Map(nodes.map((n) => [n.key, n] as const));

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const cx = (mx - ox) / scale;
    const cy = (my - oy) / scale;
    onPan(cx, cy);
  };

  return (
    <div className="absolute bottom-2 left-2 bg-white border-2 border-fg shadow-neo">
      <div className="font-mono text-[7px] font-bold uppercase tracking-wider px-1.5 py-0.5 border-b border-fg bg-bg-raised">Map</div>
      <svg width={W} height={H} className="cursor-pointer" onClick={onClick}>
        <rect x={0} y={0} width={W} height={H} fill="#fafafa" />
        {edges.map((e) => {
          const a = nodeMap.get(e.from); const b = nodeMap.get(e.to);
          if (!a || !b) return null;
          return (
            <line
              key={e.key}
              x1={a.x * scale + ox + (a.w * scale) / 2}
              y1={a.y * scale + oy + (a.h * scale) / 2}
              x2={b.x * scale + ox + (b.w * scale) / 2}
              y2={b.y * scale + oy + (b.h * scale) / 2}
              stroke="#d1d5db" strokeWidth={0.5}
            />
          );
        })}
        {nodes.map((n) => {
          const c = n.kind === "env" ? "#fbbf24"
            : n.kind === "volume" ? "#60a5fa"
            : n.kind === "server" ? "#a78bfa"
            : n.kind === "service" ? "#34d399"
            : "#111827";
          return (
            <rect
              key={n.key}
              x={n.x * scale + ox} y={n.y * scale + oy}
              width={Math.max(2, n.w * scale)} height={Math.max(2, n.h * scale)}
              fill={c}
            />
          );
        })}
        {/* viewport rectangle */}
        <rect
          x={viewBox.x * scale + ox} y={viewBox.y * scale + oy}
          width={Math.max(4, viewBox.w * scale)} height={Math.max(4, viewBox.h * scale)}
          fill="none" stroke="#111" strokeWidth={1.5} strokeDasharray="3 2"
        />
      </svg>
    </div>
  );
}

// ---------- context menu ----------

function ContextMenu({
  node, data, svgRef, clientX, clientY, onClose, onRename, onAppAction, onSvcAction, onDeleteEnv, onDetachVolume,
}: {
  node: LaidOutNode;
  data: GraphData;
  svgRef: React.RefObject<SVGSVGElement | null>;
  clientX: number;
  clientY: number;
  onClose: () => void;
  onRename: (key: NodeKey, label: string) => void;
  onAppAction: (action: string, appId: number) => void;
  onSvcAction: (action: string, svcId: number) => void;
  onDeleteEnv: (id: number, name: string) => void;
  onDetachVolume: (appId: number) => void;
}) {
  const svg = svgRef.current;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  // Clamp within the canvas container.
  const W = 180, H = 220;
  let left = clientX - rect.left;
  let top = clientY - rect.top;
  if (left + W > rect.width) left = rect.width - W - 4;
  if (top + H > rect.height) top = rect.height - H - 4;

  const Item = ({ icon: Icon, label, onClick, danger = false }: { icon: any; label: string; onClick: () => void; danger?: boolean }) => (
    <button
      onClick={() => { onClick(); onClose(); }}
      onMouseDown={(e) => e.stopPropagation()}
      className={`w-full flex items-center gap-2 px-2 py-1.5 font-mono text-[10px] uppercase hover:bg-yellow-50 ${danger ? "text-accent-red" : ""}`}
    >
      <Icon size={11} /> {label}
    </button>
  );

  const items: React.ReactNode[] = [];

  if (node.kind === "app") {
    const app = data.apps.find((a) => a.id === node.id);
    if (!app) return null;
    items.push(<Item key="r"  icon={RotateCcw} label="Restart"  onClick={() => onAppAction("restart", app.id)} />);
    items.push(app.status === "paused"
      ? <Item key="u" icon={Play}  label="Unpause" onClick={() => onAppAction("unpause", app.id)} />
      : <Item key="p" icon={Pause} label="Pause"   onClick={() => onAppAction("pause",   app.id)} />);
    items.push(<Item key="rd" icon={RefreshCw} label="Redeploy" onClick={() => onAppAction("redeploy", app.id)} />);
    items.push(<Item key="rn" icon={Edit3}     label="Rename"   onClick={() => onRename(node.key, node.label)} />);
    items.push(<Item key="lg" icon={FileText}  label="Logs"     onClick={() => { window.location.hash = `#/apps/${app.id}#logs`; }} />);
    items.push(<Item key="ds" icon={ExternalLink} label="Details" onClick={() => { window.location.hash = `#/apps/${app.id}`; }} />);
    items.push(
      <Item key="x" icon={Trash2} danger label="Destroy" onClick={async () => {
        if (await confirm("Destroy App", `Permanently destroy "${app.name}"? This removes all containers, DNS records, and webhooks.`, true)) {
          onAppAction("delete", app.id);
        }
      }} />
    );
  } else if (node.kind === "service") {
    const svc = data.services.find((s) => s.id === node.id);
    if (!svc) return null;
    items.push(<Item key="r" icon={RotateCcw} label="Restart" onClick={() => onSvcAction("restart", svc.id)} />);
    items.push(svc.status === "paused"
      ? <Item key="u" icon={Play}  label="Unpause" onClick={() => onSvcAction("unpause", svc.id)} />
      : <Item key="p" icon={Pause} label="Pause"   onClick={() => onSvcAction("pause",   svc.id)} />);
    items.push(<Item key="lg" icon={FileText}     label="Logs"    onClick={() => { window.location.hash = `#/services/${svc.id}`; }} />);
    items.push(<Item key="ds" icon={ExternalLink} label="Details" onClick={() => { window.location.hash = `#/services/${svc.id}`; }} />);
    items.push(
      <Item key="x" icon={Trash2} danger label="Destroy" onClick={async () => {
        if (await confirm("Destroy Service", `Permanently destroy "${svc.name}"? This removes all containers, volumes, and data.`, true)) {
          onSvcAction("delete", svc.id);
        }
      }} />
    );
  } else if (node.kind === "env") {
    const env = data.environments.find((e) => e.id === node.id);
    if (!env) return null;
    items.push(<Item key="rn" icon={Edit3}        label="Rename"    onClick={() => onRename(node.key, node.label)} />);
    items.push(<Item key="ed" icon={ExternalLink} label="Edit Vars" onClick={() => { window.location.hash = `#/environments`; }} />);
    items.push(<Item key="x"  icon={Trash2} danger label="Delete"   onClick={() => onDeleteEnv(env.id, env.name)} />);
  } else if (node.kind === "volume") {
    const v = data.volumes.find((x) => x.id === node.id);
    if (!v) return null;
    const app = data.apps.find((a) => a.volume_id === v.id);
    items.push(<Item key="ds" icon={ExternalLink} label="Details" onClick={() => { window.location.hash = `#/resources/volumes/${encodeURIComponent(v.id)}`; }} />);
    if (app) {
      items.push(
        <Item key="dt" icon={Trash2} danger label="Detach" onClick={async () => {
          if (await confirm("Detach Volume", `Detach "${v.name}" from "${app.name}"?`, true)) onDetachVolume(app.id);
        }} />
      );
    }
  } else if (node.kind === "server") {
    const s = data.servers.find((x) => x.id === node.id);
    if (!s) return null;
    items.push(<Item key="ds" icon={ExternalLink} label="Details" onClick={() => { window.location.hash = `#/resources/servers/${s.id}`; }} />);
  }

  return (
    <>
      <div className="fixed inset-0 z-20" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="absolute bg-white border-2 border-fg shadow-neo z-30 py-1"
        style={{ left, top, width: W }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-2 py-1 border-b border-fg/10 font-mono text-[9px] font-bold uppercase truncate">{node.label}</div>
        {items}
      </div>
    </>
  );
}

// ---------- create menu ----------

function CreateMenu({
  clientX, clientY, svgRef, catalog, onClose, onCreateEnv,
}: {
  clientX: number; clientY: number;
  svgRef: React.RefObject<SVGSVGElement | null>;
  catalog: ServiceCatalogEntry[];
  onClose: () => void;
  onCreateEnv: () => void;
}) {
  const [showCatalog, setShowCatalog] = useState(false);
  const svg = svgRef.current;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const W = showCatalog ? 280 : 200;
  const H = showCatalog ? 320 : 160;
  let left = clientX - rect.left;
  let top = clientY - rect.top;
  if (left + W > rect.width) left = rect.width - W - 4;
  if (top + H > rect.height) top = rect.height - H - 4;

  const Row = ({ icon: Icon, label, sub, onClick, chevron = false }: { icon: any; label: string; sub?: string; onClick: () => void; chevron?: boolean }) => (
    <button
      onClick={() => { onClick(); }}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-full flex items-center gap-2 px-2 py-2 hover:bg-yellow-50 text-left"
    >
      <Icon size={14} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[10px] font-bold uppercase">{label}</div>
        {sub && <div className="font-mono text-[8px] text-muted truncate">{sub}</div>}
      </div>
      {chevron && <ChevronRight size={11} className="text-muted" />}
    </button>
  );

  return (
    <>
      <div className="fixed inset-0 z-20" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="absolute bg-white border-2 border-fg shadow-neo z-30"
        style={{ left, top, width: W, maxHeight: H, overflow: "auto" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-2 py-1 border-b border-fg/10 bg-bg-raised">
          <div className="font-mono text-[9px] font-bold uppercase">{showCatalog ? "Pick Service" : "Add to Canvas"}</div>
          <button onClick={onClose} className="text-muted hover:text-fg"><X size={11} /></button>
        </div>
        {!showCatalog ? (
          <div className="py-1">
            <Row icon={Box}      label="Deploy App"   sub="GitHub repo or image" onClick={() => { window.location.hash = "#/deploy"; onClose(); }} />
            <Row icon={Database} label="Add Service"  sub="Postgres, Redis, …"   onClick={() => setShowCatalog(true)} chevron />
            <Row icon={Layers}   label="New Environment" sub="env-var bundle"    onClick={() => { onCreateEnv(); onClose(); }} />
          </div>
        ) : (
          <div className="py-1">
            <button
              onClick={() => setShowCatalog(false)}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-full flex items-center gap-1 px-2 py-1 hover:bg-yellow-50 font-mono text-[9px] uppercase text-muted"
            >← Back</button>
            {catalog.length === 0 ? (
              <Row icon={Database} label="Open Service Wizard" sub="(catalog unavailable)" onClick={() => { window.location.hash = "#/deploy-service"; onClose(); }} />
            ) : catalog.map((c) => (
              <Row
                key={c.type}
                icon={Database}
                label={c.label}
                sub={c.description || c.category || c.type}
                onClick={() => { window.location.hash = `#/deploy-service/${c.type}`; onClose(); }}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------- popover ----------

function NodePopover({
  node, data, viewBox, svgRef, actionLoading, busy, onClose, onAppAction, onSvcAction,
}: {
  node: LaidOutNode;
  data: GraphData;
  viewBox: { x: number; y: number; w: number; h: number };
  svgRef: React.RefObject<SVGSVGElement | null>;
  actionLoading: string | null;
  busy: boolean;
  onClose: () => void;
  onAppAction: (action: string, appId: number) => void;
  onSvcAction: (action: string, svcId: number) => void;
}) {
  const svg = svgRef.current;
  if (!svg) return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const pt = svg.createSVGPoint();
  pt.x = node.x + node.w;
  pt.y = node.y + node.h;
  const screen = pt.matrixTransform(ctm);
  const rect = svg.getBoundingClientRect();
  void viewBox;
  const left = screen.x - rect.left + 8;
  const top = screen.y - rect.top + 8;

  const Icon = ICONS[node.kind];
  const Loading = (action: string, kind: "app" | "svc") => {
    const k = kind === "app" ? `app-${action}-${node.id}` : `svc-${action}-${node.id}`;
    return actionLoading === k;
  };

  return (
    <div
      className="absolute bg-white border-2 border-fg shadow-neo p-3 w-64 z-10"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={14} />
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-bold uppercase truncate">{node.label}</div>
            <div className="font-mono text-[8px] text-muted uppercase">
              {node.kind}{busy && <span className="ml-1 text-accent-blue">· in flight</span>}
            </div>
          </div>
        </div>
        <button onClick={onClose} className="font-mono text-[10px] text-muted hover:text-fg px-1" aria-label="Close">×</button>
      </div>

      {node.kind === "app" && (() => {
        const app = data.apps.find((a) => a.id === node.id);
        if (!app) return null;
        const env = app.environment_id != null ? data.environments.find((e) => e.id === app.environment_id) : null;
        const replicaCount = data.replicas.filter((r) => r.app_id === app.id).length;
        return (
          <div className="space-y-2">
            <div className="font-mono text-[9px] text-muted space-y-0.5">
              <div>status: <span style={{ color: statusColor(app.status) }}>{app.status}</span></div>
              {app.domain && (
                <div className="flex items-center gap-1"><Globe size={9} /><a href={`https://${app.domain}`} target="_blank" rel="noopener" className="text-accent-blue hover:underline truncate">{app.domain}</a></div>
              )}
              <div>replicas: {replicaCount} / desired {app.desired_replicas}</div>
              {env && <div>env: {env.name}</div>}
            </div>
            <div className="flex items-center gap-1 border-t border-fg/10 pt-2">
              <PermissionGate permission="apps.restart">
                <Btn size="xs" variant="ghost" loading={Loading("restart", "app")} onClick={() => onAppAction("restart", app.id)} title="Restart"><RotateCcw size={12} /></Btn>
              </PermissionGate>
              <PermissionGate permission="apps.pause">
                {app.status === "paused"
                  ? <Btn size="xs" variant="ghost" loading={Loading("unpause", "app")} onClick={() => onAppAction("unpause", app.id)} title="Unpause"><Play size={12} /></Btn>
                  : <Btn size="xs" variant="ghost" loading={Loading("pause", "app")} onClick={() => onAppAction("pause", app.id)} title="Pause"><Pause size={12} /></Btn>
                }
              </PermissionGate>
              <PermissionGate permission="apps.redeploy">
                <Btn size="xs" variant="ghost" loading={Loading("redeploy", "app")} onClick={() => onAppAction("redeploy", app.id)} title="Redeploy"><RefreshCw size={12} /></Btn>
              </PermissionGate>
              <PermissionGate permission="apps.destroy">
                <Btn
                  size="xs" variant="ghost"
                  loading={Loading("delete", "app")}
                  onClick={async () => {
                    if (await confirm("Destroy App", `Permanently destroy "${app.name}"? This removes all containers, DNS records, and webhooks.`, true)) {
                      onAppAction("delete", app.id);
                    }
                  }}
                  title="Destroy"
                ><Trash2 size={12} className="text-accent-red" /></Btn>
              </PermissionGate>
              <a href={`#/apps/${app.id}`} className="ml-auto font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline flex items-center gap-1">
                Details <ExternalLink size={9} />
              </a>
            </div>
          </div>
        );
      })()}

      {node.kind === "service" && (() => {
        const svc = data.services.find((s) => s.id === node.id);
        if (!svc) return null;
        const linkCount = data.service_links.filter((l) => l.service_id === svc.id).length;
        const instCount = data.service_instances.filter((i) => i.service_id === svc.id).length;
        return (
          <div className="space-y-2">
            <div className="font-mono text-[9px] text-muted space-y-0.5">
              <div>status: <span style={{ color: statusColor(svc.status) }}>{svc.status}</span></div>
              <div>{svc.service_type} {svc.version}</div>
              <div>instances: {instCount}</div>
              <div>injected into {linkCount} env{linkCount === 1 ? "" : "s"}</div>
            </div>
            <div className="flex items-center gap-1 border-t border-fg/10 pt-2">
              <PermissionGate permission="services.manage">
                <Btn size="xs" variant="ghost" loading={Loading("restart", "svc")} onClick={() => onSvcAction("restart", svc.id)} title="Restart"><RotateCcw size={12} /></Btn>
                {svc.status === "paused"
                  ? <Btn size="xs" variant="ghost" loading={Loading("unpause", "svc")} onClick={() => onSvcAction("unpause", svc.id)} title="Unpause"><Play size={12} /></Btn>
                  : <Btn size="xs" variant="ghost" loading={Loading("pause", "svc")} onClick={() => onSvcAction("pause", svc.id)} title="Pause"><Pause size={12} /></Btn>
                }
              </PermissionGate>
              <PermissionGate permission="services.destroy">
                <Btn
                  size="xs" variant="ghost"
                  loading={Loading("delete", "svc")}
                  onClick={async () => {
                    if (await confirm("Destroy Service", `Permanently destroy "${svc.name}"? This removes all containers, volumes, and data.`, true)) {
                      onSvcAction("delete", svc.id);
                    }
                  }}
                  title="Destroy"
                ><Trash2 size={12} className="text-accent-red" /></Btn>
              </PermissionGate>
              <a href={`#/services/${svc.id}`} className="ml-auto font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline flex items-center gap-1">
                Details <ExternalLink size={9} />
              </a>
            </div>
          </div>
        );
      })()}

      {node.kind === "server" && (() => {
        const s = data.servers.find((x) => x.id === node.id);
        if (!s) return null;
        const replicaCount = data.replicas.filter((r) => r.server_id === s.id).length;
        const instCount = data.service_instances.filter((i) => i.server_id === s.id).length;
        return (
          <div className="space-y-2">
            <div className="font-mono text-[9px] text-muted space-y-0.5">
              <div>status: <span style={{ color: statusColor(s.status) }}>{s.status}</span></div>
              <div>{s.type} · {s.location}</div>
              {s.ipv4 && <div>{s.ipv4}</div>}
              <div>{replicaCount} replica{replicaCount === 1 ? "" : "s"} · {instCount} service inst</div>
            </div>
            <a href={`#/resources/servers/${s.id}`} className="block text-right font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline border-t border-fg/10 pt-2">
              Details <ExternalLink size={9} className="inline" />
            </a>
          </div>
        );
      })()}

      {node.kind === "env" && (() => {
        const e = data.environments.find((x) => x.id === node.id);
        if (!e) return null;
        const appCount = data.apps.filter((a) => a.environment_id === e.id).length;
        const svcCount = data.service_links.filter((l) => l.environment_id === e.id).length;
        return (
          <div className="space-y-2">
            <div className="font-mono text-[9px] text-muted space-y-0.5">
              <div>{e.var_count} variable{e.var_count === 1 ? "" : "s"}</div>
              <div>used by {appCount} app{appCount === 1 ? "" : "s"}, {svcCount} service link{svcCount === 1 ? "" : "s"}</div>
              <div className="text-[8px] pt-1">drag handle onto an app or service to link</div>
            </div>
            <a href={`#/environments`} className="block text-right font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline border-t border-fg/10 pt-2">
              Details <ExternalLink size={9} className="inline" />
            </a>
          </div>
        );
      })()}

      {node.kind === "volume" && (() => {
        const v = data.volumes.find((x) => x.id === node.id);
        if (!v) return null;
        const app = data.apps.find((a) => a.volume_id === v.id);
        return (
          <div className="space-y-2">
            <div className="font-mono text-[9px] text-muted space-y-0.5">
              <div>{v.size_gb} GB · {v.location}</div>
              {app && <div>mounted by: {app.name}</div>}
            </div>
            <a href={`#/resources/volumes/${encodeURIComponent(v.id)}`} className="block text-right font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline border-t border-fg/10 pt-2">
              Details <ExternalLink size={9} className="inline" />
            </a>
          </div>
        );
      })()}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
