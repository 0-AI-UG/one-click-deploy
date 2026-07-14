import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { StatusBadge } from "../components/ui.tsx";

// ---------------------------------------------------------------------------
// Types — re-declared locally (mirrors src/server/routes/topology.ts) so the
// web project never imports a file outside its rootDir. Exported so the parent
// can type the value it fetches from GET /api/topology and pass it in.
// ---------------------------------------------------------------------------
export type TopologyServer = {
  id: number; name: string; ipv4: string; private_ipv4: string | null;
  type: string | null; location: string | null; isPanel: boolean;
};
export type TopologyApp = {
  id: number; name: string; status: string; public: 0 | 1; domain: string | null;
  internal_port: number | null; internal_protocol: string; sticky: boolean;
  stack_id: number | null; stack_name: string | null; desired_replicas: number;
};
export type TopologyReplica = {
  id: number; app_id: number; server_id: number; host_port: number | null;
  status: string; container_name: string;
};
export type TopologyLink = { from: number; to: number; key: string; sharedEnv: boolean };
export type TopologyData = {
  panelServerId: number | null;
  servers: TopologyServer[];
  apps: TopologyApp[];
  replicas: TopologyReplica[];
  links: TopologyLink[];
};

// ---------------------------------------------------------------------------
// Layout constants (all coordinates are in a fixed logical board space that the
// board scrolls horizontally; edges are computed from these — never from DOM).
// ---------------------------------------------------------------------------
const CARD_W = 176;
const HEADER_H = 30;
const REP_ROW_H = 22;
const REPS_VPAD = 12;
const CHIPS_PER_ROW = 3;
const CARD_GAP = 22;
const STACK_PAD = 14; // stack box padding around member fragments
const REGION_HEADER_H = 30;
const REGION_VPAD = 24;
const REGION_GAP = 60;
const ROW_GAP = 26; // vertical gap between wrapped card rows within a region
const ENV_LANE_TOP = 16; // gap from a row's bottom to its first env-link lane
const ENV_LANE_STEP = 20; // vertical distance between stacked env-link lanes
const ENV_LANE_BOT = 8; // gap after the last env-link lane before the next row
const LEFT_MARGIN = 100; // left inner margin of a region (trunk lanes live here)
const RIGHT_MARGIN = 80; // right inner margin (wake lane lives here)
const BOARD_PAD = 28;
const NODE_W = 176;
const NODE_H = 46;

type Pt = [number, number];
type Rect = { left: number; top: number; w: number; h: number; cx: number; cy: number };

const rectFrom = (left: number, top: number, w: number, h: number): Rect => ({
  left, top, w, h, cx: left + w / 2, cy: top + h / 2,
});
const T = (r: Rect): Pt => [r.cx, r.top];
const B = (r: Rect): Pt => [r.cx, r.top + r.h];
const L = (r: Rect): Pt => [r.left, r.cy];
const R = (r: Rect): Pt => [r.left + r.w, r.cy];

const cardHeight = (chips: number) => {
  const rows = Math.max(1, Math.ceil(chips / CHIPS_PER_ROW));
  return HEADER_H + REPS_VPAD + rows * REP_ROW_H;
};

// Rounded orthogonal SVG path (quadratic corner fillets) — from the artifact.
function roundedPath(raw: Pt[], rad = 8): string {
  const pts = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0) || 1, d2 = Math.hypot(x2 - x1, y2 - y1) || 1;
    const r1 = Math.min(rad, d1 / 2), r2 = Math.min(rad, d2 / 2);
    d += ` L ${x1 - ((x1 - x0) / d1) * r1} ${y1 - ((y1 - y0) / d1) * r1}` +
      ` Q ${x1} ${y1} ${x1 + ((x2 - x1) / d2) * r2} ${y1 + ((y2 - y1) / d2) * r2}`;
  }
  const e = pts[pts.length - 1];
  d += ` L ${e[0]} ${e[1]}`;
  return d;
}

const labelAt = (pts: Pt[]): Pt => {
  const i = Math.max(0, Math.floor((pts.length - 1) / 2));
  const a = pts[i], b = pts[i + 1] ?? pts[i];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
};

type EdgeKind = "ing" | "env" | "wake" | "tie";
type Edge = {
  id: string; kind: EdgeKind; pts: Pt[];
  label?: string; always?: boolean;
  appIds: number[]; infra: string[];
};
type InfraKind = "net" | "pub" | "waker";
type InfraNode = { key: InfraKind; rect: Rect; name: string; sub: string };
type FragRender = {
  key: string; app: TopologyApp; serverId: number;
  reps: TopologyReplica[]; anchorOnly: boolean; split: boolean; total: number; rect: Rect;
};
type RegionRender = {
  id: number; name: string; meta: string; badge: number;
  x: number; y: number; w: number; h: number; ingress: boolean;
};
type StackRender = { key: string; label: string; x: number; y: number; w: number; h: number };
type Layout = {
  board: { w: number; h: number };
  regions: RegionRender[];
  frags: FragRender[];
  infra: InfraNode[];
  stacks: StackRender[];
  edges: Edge[];
  panelIp: string | null;
};

function computeLayout(data: TopologyData, availW: number): Layout | null {
  const { servers, apps, replicas, links } = data;
  if (servers.length === 0) return null;

  const appById = new Map(apps.map((a) => [a.id, a]));
  const serverById = new Map(servers.map((s) => [s.id, s]));
  const ingressServerId = data.panelServerId ?? servers[0].id;
  const panelIp = serverById.get(ingressServerId)?.ipv4 ?? null;

  const repsByApp = new Map<number, TopologyReplica[]>();
  for (const r of replicas) {
    const arr = repsByApp.get(r.app_id) ?? [];
    arr.push(r);
    repsByApp.set(r.app_id, arr);
  }

  // Servers ordered: panel first, then by id.
  const orderedServers = [...servers].sort((a, b) =>
    a.isPanel === b.isPanel ? a.id - b.id : a.isPanel ? -1 : 1);

  // --- Build fragments: one card fragment per server an app has replicas on;
  //     a replica-less (sleeping) app gets a single anchor fragment. ---
  type FragSeed = {
    key: string; app: TopologyApp; serverId: number;
    reps: TopologyReplica[]; anchorOnly: boolean; split: boolean; total: number;
  };
  const seeds: FragSeed[] = [];
  for (const app of apps) {
    const reps = repsByApp.get(app.id) ?? [];
    const serverIds = [...new Set(reps.map((r) => r.server_id))];
    if (serverIds.length === 0) {
      // Sleeping / no replicas: anchor on the panel (or first server).
      seeds.push({
        key: `${app.id}`, app, serverId: ingressServerId,
        reps: [], anchorOnly: true, split: false, total: 0,
      });
      continue;
    }
    const split = serverIds.length > 1;
    for (const sid of serverIds) {
      const sreps = reps.filter((r) => r.server_id === sid);
      seeds.push({
        key: split ? `${app.id}@${sid}` : `${app.id}`, app, serverId: sid,
        reps: sreps, anchorOnly: false, split, total: reps.length,
      });
    }
  }

  const seedsByServer = new Map<number, FragSeed[]>();
  for (const s of seeds) {
    const arr = seedsByServer.get(s.serverId) ?? [];
    arr.push(s);
    seedsByServer.set(s.serverId, arr);
  }

  // --- Lay out each server region as a wrapping grid of card fragments sized to
  //     the available board width, so the board never scrolls horizontally.
  //     Stack members are grouped contiguously and given their own rows so a
  //     stack box bounds them cleanly without ever enclosing a foreign card. ---
  const frags: FragRender[] = [];
  const fragByKey = new Map<string, FragRender>();
  const regions: RegionRender[] = [];
  const stacks: StackRender[] = [];

  // Fit the logical content width to the measured board space. boardW below is
  // regionLeft + contentW + BOARD_PAD, and the board lives inside the padded
  // (p-3.5 = 14px each side) scroller, so contentW ≤ availW - 84.
  const regionLeft = BOARD_PAD;
  const contentW = Math.max(356, (availW > 0 ? availW - 84 : 780));
  const usableW = contentW - LEFT_MARGIN - RIGHT_MARGIN;
  const cols = Math.max(1, Math.floor((usableW + CARD_GAP) / (CARD_W + CARD_GAP)));

  // Pass 1 — flow each server's frags into a grid of `cols` columns and record
  // which (server, row) each frag landed in (needed to route env links cleanly).
  type RowPlan = { cards: Array<{ seed: FragSeed; h: number }>; rowH: number };
  const rowPlans: Array<{ server: TopologyServer; rows: RowPlan[]; replicaCount: number }> = [];
  const place = new Map<string, { reg: number; row: number }>();
  for (const server of orderedServers) {
    const list = seedsByServer.get(server.id) ?? [];
    // order: stack members (by stack_id, then name) first, then standalone by name
    list.sort((a, b) => {
      const sa = a.app.stack_id, sb = b.app.stack_id;
      if (sa !== sb) {
        if (sa == null) return 1;
        if (sb == null) return -1;
        return sa - sb;
      }
      return a.app.name.localeCompare(b.app.name);
    });

    // Flow into rows: break to a new row at every stack boundary (so each stack
    // owns whole rows) and whenever the current row is full.
    const rows: RowPlan[] = [];
    let cur: Array<{ seed: FragSeed; h: number }> = [];
    let curStack: number | null | undefined = undefined;
    const flush = () => { if (cur.length) { rows.push({ cards: cur, rowH: Math.max(...cur.map((c) => c.h)) }); cur = []; } };
    for (const seed of list) {
      const h = cardHeight(seed.anchorOnly ? 1 : Math.max(1, seed.reps.length));
      if (seed.app.stack_id !== curStack) flush();
      if (cur.length >= cols) flush();
      cur.push({ seed, h });
      curStack = seed.app.stack_id;
    }
    flush();
    rows.forEach((row, ri) => row.cards.forEach((c) => place.set(c.seed.key, { reg: server.id, row: ri })));
    rowPlans.push({ server, rows, replicaCount: replicas.filter((r) => r.server_id === server.id).length });
  }

  // Primary fragment key per app (most replicas) — the env-link endpoint.
  const primaryKeyByApp = new Map<number, string>();
  {
    const byApp = new Map<number, FragSeed[]>();
    for (const s of seeds) { const a = byApp.get(s.app.id) ?? []; a.push(s); byApp.set(s.app.id, a); }
    for (const [aid, arr] of byApp) {
      primaryKeyByApp.set(aid, arr.reduce((b, s) => (s.reps.length > b.reps.length ? s : b), arr[0]).key);
    }
  }

  // Dedupe env links (A↔B once), then reserve a horizontal lane below the row
  // for every link whose endpoints share a row — each gets its own slot so the
  // arrows and labels never stack on top of each other.
  const envList: Array<{ from: number; to: number; key: string; pair: string }> = [];
  {
    const seen = new Set<string>();
    for (const link of links) {
      const pair = link.from < link.to ? `${link.from}:${link.to}` : `${link.to}:${link.from}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      envList.push({ from: link.from, to: link.to, key: link.key, pair });
    }
  }
  // Horizontal env segments live only in "bands" — the gap directly below a row
  // (band `${reg}:${r}` sits between row r and row r+1). Every edge that crosses
  // a band takes the next free slot in it, so no two segments ever share a Y.
  const bandDemand = new Map<string, number>();
  const takeSlot = (band: string) => {
    const s = bandDemand.get(band) ?? 0;
    bandDemand.set(band, s + 1);
    return s;
  };
  type EnvRoute =
    | { kind: "same"; band: string; slot: number }
    | { kind: "adj"; band: string; slot: number; upKey: string; loKey: string }
    | { kind: "dist"; bandU: string; slotU: number; bandL: string; slotL: number; upKey: string; loKey: string }
    | { kind: "cross" };
  const envRoute = new Map<string, EnvRoute>();
  for (const e of envList) {
    const ka = primaryKeyByApp.get(e.from), kb = primaryKeyByApp.get(e.to);
    const pa = ka ? place.get(ka) : undefined, pb = kb ? place.get(kb) : undefined;
    if (!ka || !kb || !pa || !pb) continue;
    if (pa.reg !== pb.reg) { envRoute.set(e.pair, { kind: "cross" }); continue; }
    if (pa.row === pb.row) {
      const band = `${pa.reg}:${pa.row}`;
      envRoute.set(e.pair, { kind: "same", band, slot: takeSlot(band) });
      continue;
    }
    const up = pa.row < pb.row ? { p: pa, k: ka } : { p: pb, k: kb };
    const lo = pa.row < pb.row ? { p: pb, k: kb } : { p: pa, k: ka };
    if (lo.p.row - up.p.row === 1) {
      const band = `${up.p.reg}:${up.p.row}`;
      envRoute.set(e.pair, { kind: "adj", band, slot: takeSlot(band), upKey: up.k, loKey: lo.k });
    } else {
      const bandU = `${up.p.reg}:${up.p.row}`, bandL = `${lo.p.reg}:${lo.p.row - 1}`;
      envRoute.set(e.pair, {
        kind: "dist", bandU, slotU: takeSlot(bandU), bandL, slotL: takeSlot(bandL), upKey: up.k, loKey: lo.k,
      });
    }
  }
  const laneBand = (rowKey: string) => {
    const n = bandDemand.get(rowKey) ?? 0;
    return n > 0 ? ENV_LANE_TOP + n * ENV_LANE_STEP + ENV_LANE_BOT : 0;
  };

  // Pass 2 — assign local coordinates, growing the gap below any row that hosts
  // env lanes so they fit between rows (and inside the region for the last row).
  type RegionPlan = {
    server: TopologyServer;
    items: Array<{ seed: FragSeed; localX: number; localY: number; h: number }>;
    rowsH: number; replicaCount: number;
    rowBottomLocal: Array<number>;
  };
  const plans: RegionPlan[] = [];
  for (const rp of rowPlans) {
    const items: RegionPlan["items"] = [];
    const rowBottomLocal: number[] = [];
    let localTop = 0;
    rp.rows.forEach((row, ri) => {
      let x = LEFT_MARGIN;
      for (let i = 0; i < row.cards.length; i++) {
        const c = row.cards[i];
        if (i > 0) x += CARD_GAP;
        items.push({ seed: c.seed, localX: x, localY: localTop + (row.rowH - c.h) / 2, h: c.h });
        x += CARD_W;
      }
      rowBottomLocal[ri] = localTop + row.rowH;
      const band = laneBand(`${rp.server.id}:${ri}`);
      const gap = ri === rp.rows.length - 1 ? band : Math.max(ROW_GAP, band);
      localTop += row.rowH + gap;
    });
    plans.push({ server: rp.server, items, rowsH: localTop, replicaCount: rp.replicaCount, rowBottomLocal });
  }

  // --- Vertical ingress strip above the regions. ---
  const netCy = BOARD_PAD + 24;
  const infraCy = netCy + 84;
  const BUS_Y = infraCy + 52;
  const WAKE_LANE_Y = BUS_Y - 4;

  const sleepingApps = apps.filter((a) => a.status === "sleeping");
  const hasWaker = sleepingApps.length > 0;

  const pubRect = rectFrom(regionLeft + 120 - NODE_W / 2, infraCy - NODE_H / 2, NODE_W, NODE_H);
  const wakerRect = rectFrom(pubRect.left + NODE_W + 70, infraCy - NODE_H / 2, NODE_W, NODE_H);
  const netRect = rectFrom(regionLeft + contentW / 2 - NODE_W / 2, netCy - NODE_H / 2, NODE_W, NODE_H);

  const infra: InfraNode[] = [
    { key: "net", rect: netRect, name: "Public Internet", sub: "HTTPS :443" },
    {
      key: "pub", rect: pubRect, name: "ocd-traefik",
      sub: `${serverById.get(ingressServerId)?.name ?? "panel"} · :443 TLS · round-robin`,
    },
  ];
  if (hasWaker) infra.push({ key: "waker", rect: wakerRect, name: "waker", sub: "ocd-waker-http :8896" });

  const TRUNK_X1 = regionLeft + 38;
  const TRUNK_X2 = regionLeft + 58;
  const WAKE_X = regionLeft + contentW - 34;

  // --- Third pass: assign region Y positions and absolute card rects. ---
  const rowBottomAbs = new Map<string, number>(); // `${reg}:${row}` -> absolute y
  let y = BUS_Y + 34;
  for (const plan of plans) {
    const regionH = REGION_HEADER_H + REGION_VPAD * 2 + plan.rowsH;
    const rowTop = y + REGION_HEADER_H + REGION_VPAD;
    const s = plan.server;
    const meta = [s.ipv4, s.type, s.id === ingressServerId ? "◆ ingress" : null]
      .filter(Boolean).join(" · ");
    regions.push({
      id: s.id, name: s.name, meta, badge: plan.replicaCount,
      x: regionLeft, y, w: contentW, h: regionH, ingress: s.id === ingressServerId,
    });
    for (const it of plan.items) {
      const rect = rectFrom(regionLeft + it.localX, rowTop + it.localY, CARD_W, it.h);
      const fr: FragRender = {
        key: it.seed.key, app: it.seed.app, serverId: it.seed.serverId,
        reps: it.seed.reps, anchorOnly: it.seed.anchorOnly,
        split: it.seed.split, total: it.seed.total, rect,
      };
      frags.push(fr);
      fragByKey.set(fr.key, fr);
    }
    plan.rowBottomLocal.forEach((bottom, ri) => rowBottomAbs.set(`${s.id}:${ri}`, rowTop + bottom));
    y += regionH + REGION_GAP;
  }
  const boardH = y - REGION_GAP + BOARD_PAD;
  const boardW = regionLeft + contentW + BOARD_PAD;

  // --- Stack boxes: bound all fragments of a stack within one region. ---
  const stackGroups = new Map<string, FragRender[]>();
  for (const f of frags) {
    if (f.app.stack_id == null) continue;
    const k = `${f.serverId}:${f.app.stack_id}`;
    const arr = stackGroups.get(k) ?? [];
    arr.push(f);
    stackGroups.set(k, arr);
  }
  for (const [k, group] of stackGroups) {
    const minx = Math.min(...group.map((f) => f.rect.left));
    const maxx = Math.max(...group.map((f) => f.rect.left + f.rect.w));
    const miny = Math.min(...group.map((f) => f.rect.top));
    // Extend the box past the bottom row's env-lane band so intra-stack env
    // links (which drop into the lane below their row) stay inside the box.
    const bottomRow = Math.max(...group.map((f) => place.get(f.key)?.row ?? 0));
    const rk = `${group[0].serverId}:${bottomRow}`;
    const band = laneBand(rk);
    const maxy = Math.max(
      Math.max(...group.map((f) => f.rect.top + f.rect.h)),
      band > 0 ? (rowBottomAbs.get(rk) ?? 0) + band - ENV_LANE_BOT : 0,
    );
    stacks.push({
      key: k, label: `◆ Stack · ${group[0].app.stack_name ?? group[0].app.stack_id}`,
      x: minx - STACK_PAD, y: miny - STACK_PAD,
      w: maxx - minx + STACK_PAD * 2, h: maxy - miny + STACK_PAD * 2,
    });
  }

  // All fragments per app (for target-group ties); primary is the env endpoint.
  const fragsByApp = new Map<number, FragRender[]>();
  for (const f of frags) {
    const arr = fragsByApp.get(f.app.id) ?? [];
    arr.push(f);
    fragsByApp.set(f.app.id, arr);
  }
  const primaryFrag = (appId: number): FragRender | undefined =>
    fragByKey.get(primaryKeyByApp.get(appId) ?? "");

  // ---------------------------------------------------------------------------
  // Edges
  // ---------------------------------------------------------------------------
  const edges: Edge[] = [];

  // Internet → panel Traefik
  {
    const my = (netRect.top + netRect.h + pubRect.top) / 2;
    edges.push({
      id: "net-pub", kind: "ing",
      pts: [B(netRect), [netRect.cx, my], [pubRect.cx, my], T(pubRect)],
      label: panelIp ? `DNS A → ${panelIp}` : "DNS A", always: true,
      appIds: [], infra: ["net", "pub"],
    });
  }

  // Ingress LB: panel Traefik → every public + running fragment.
  let crossLane = 0;
  let labelledTrunk = false;
  for (const f of frags) {
    if (!(f.app.public && f.app.status === "running")) continue;
    if (f.serverId === ingressServerId) {
      edges.push({
        id: `ing-${f.key}`, kind: "ing",
        pts: [B(pubRect), [pubRect.cx, BUS_Y], [f.rect.cx, BUS_Y], T(f.rect)],
        appIds: [f.app.id], infra: ["pub"],
      });
    } else {
      const lane = crossLane++ % 2 === 0 ? TRUNK_X1 : TRUNK_X2;
      const priv = serverById.get(f.serverId)?.private_ipv4;
      const label = !labelledTrunk ? (priv ? `${priv} private net` : "private net") : undefined;
      if (label) labelledTrunk = true;
      edges.push({
        id: `ing-${f.key}`, kind: "ing",
        pts: [B(pubRect), [pubRect.cx, BUS_Y], [lane, BUS_Y], [lane, f.rect.cy], L(f.rect)],
        label, appIds: [f.app.id], infra: ["pub"],
      });
    }
  }

  // Target-group ties: fragments of a split app, connected top→bottom by row.
  for (const [appId, group] of fragsByApp) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.rect.cy - b.rect.cy);
    for (let i = 0; i < sorted.length - 1; i++) {
      const u = sorted[i].rect, l = sorted[i + 1].rect;
      const my = (u.top + u.h + l.top) / 2;
      edges.push({
        id: `tie-${appId}-${i}`, kind: "tie",
        pts: [B(u), [u.cx, my], [l.cx, my], T(l)],
        label: i === 0 ? `◆ ${sorted[0].total} replicas · 1 target group` : undefined,
        always: i === 0, appIds: [appId], infra: [],
      });
    }
  }

  // Env links: each routed through its reserved band slot(s) so no arrow or
  // label ever overlaps another or crosses a card body.
  const laneY = (band: string, slot: number) =>
    (rowBottomAbs.get(band) ?? 0) + ENV_LANE_TOP + slot * ENV_LANE_STEP;
  for (const e of envList) {
    const a = primaryFrag(e.from), b = primaryFrag(e.to);
    if (!a || !b) continue;
    const r = envRoute.get(e.pair);
    let pts: Pt[];
    if (r?.kind === "same") {
      const yy = laneY(r.band, r.slot);
      pts = [B(a.rect), [a.rect.cx, yy], [b.rect.cx, yy], B(b.rect)];
    } else if (r?.kind === "adj") {
      const up = fragByKey.get(r.upKey)!.rect, lo = fragByKey.get(r.loKey)!.rect;
      const yy = laneY(r.band, r.slot);
      pts = [B(up), [up.cx, yy], [lo.cx, yy], T(lo)];
    } else if (r?.kind === "dist") {
      const up = fragByKey.get(r.upKey)!.rect, lo = fragByKey.get(r.loKey)!.rect;
      const yu = laneY(r.bandU, r.slotU), yl = laneY(r.bandL, r.slotL);
      const channelX = Math.min(up.left, lo.left) - CARD_GAP / 2;
      pts = [B(up), [up.cx, yu], [channelX, yu], [channelX, yl], [lo.cx, yl], T(lo)];
    } else {
      // Cross-region: a simple detour through the empty gap between regions.
      const hi = a.rect.cy <= b.rect.cy ? a.rect : b.rect;
      const lo = a.rect.cy <= b.rect.cy ? b.rect : a.rect;
      const my = (hi.top + hi.h + lo.top) / 2;
      pts = [B(hi), [hi.cx, my], [lo.cx, my], T(lo)];
    }
    edges.push({
      id: `env-${e.pair}`, kind: "env", pts,
      label: e.key, appIds: [e.from, e.to], infra: [],
    });
  }

  // Wake proxy: panel Traefik → waker, waker → each sleeping fragment.
  if (hasWaker) {
    edges.push({
      id: "wake-pub-waker", kind: "wake",
      pts: [R(pubRect), L(wakerRect)], label: "sleeping routers", always: true,
      appIds: sleepingApps.map((a) => a.id), infra: ["pub", "waker"],
    });
    for (const app of sleepingApps) {
      const f = primaryFrag(app.id);
      if (!f) continue;
      edges.push({
        id: `wake-${app.id}`, kind: "wake",
        pts: [
          B(wakerRect), [wakerRect.cx, WAKE_LANE_Y], [WAKE_X, WAKE_LANE_Y],
          [WAKE_X, f.rect.cy], R(f.rect),
        ],
        label: "wake", appIds: [app.id], infra: ["waker"],
      });
    }
  }

  return { board: { w: boardW, h: boardH }, regions, frags, infra, stacks, edges, panelIp };
}

// ---------------------------------------------------------------------------
// Focus computation (hover / selection trace highlighting)
// ---------------------------------------------------------------------------
type FocusRef = { type: "app"; id: number } | { type: "infra"; id: InfraKind };
type FocusSets = { edges: Set<string>; apps: Set<number>; infra: Set<string> };

function computeFocus(
  focus: FocusRef | null, edges: Edge[], appById: Map<number, TopologyApp>,
): FocusSets | null {
  if (!focus) return null;
  const e = new Set<string>(), apps = new Set<number>(), infra = new Set<string>();
  if (focus.type === "app") {
    apps.add(focus.id);
    for (const ed of edges) {
      if (ed.appIds.includes(focus.id)) {
        e.add(ed.id);
        ed.appIds.forEach((a) => apps.add(a));
      }
    }
    const app = appById.get(focus.id);
    if (app) {
      if (app.public) infra.add("net");
      if (app.public && app.status === "running") infra.add("pub");
      if (app.status === "sleeping") { infra.add("waker"); infra.add("pub"); }
    }
  } else {
    infra.add(focus.id);
    for (const ed of edges) {
      if (ed.infra.includes(focus.id)) {
        e.add(ed.id);
        ed.appIds.forEach((a) => apps.add(a));
      }
    }
  }
  return { edges: e, apps, infra };
}

// ---------------------------------------------------------------------------
// Edge visual style
// ---------------------------------------------------------------------------
const EDGE_STYLE: Record<EdgeKind, { c: string; w: number; d?: string; o: number; m?: string }> = {
  ing: { c: "#5B8DEF", w: 2, o: 0.85, m: "url(#ocd-ar-blue)" },
  env: { c: "#1A1A1A", w: 2, d: "6 4", o: 0.55, m: "url(#ocd-ar-dark)" },
  wake: { c: "#FFB800", w: 2.4, d: "2 5", o: 0.9, m: "url(#ocd-ar-amber)" },
  tie: { c: "#8A8A8A", w: 1.6, d: "1 4", o: 0.8 },
};

const labelClass: Record<EdgeKind, string> = {
  ing: "bg-accent-blue text-white border-fg",
  env: "bg-bg-raised text-fg border-fg",
  wake: "bg-accent-amber text-fg border-fg",
  tie: "bg-alt text-fg border-fg",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function TopologyGraph({ data }: { data: TopologyData }) {
  const [layers, setLayers] = useState({ ing: true, env: true, wake: true, lab: false });
  const [hover, setHover] = useState<FocusRef | null>(null);
  const [selected, setSelected] = useState<FocusRef | null>(null);

  // Measure the scroller so the layout can wrap cards to fit (no h-scroll).
  const boardRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState(0);
  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => setAvailW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const appById = useMemo(() => new Map(data.apps.map((a) => [a.id, a])), [data.apps]);
  const serverById = useMemo(() => new Map(data.servers.map((s) => [s.id, s])), [data.servers]);
  const layout = useMemo(() => computeLayout(data, availW), [data, availW]);

  const focus = selected ?? hover;
  const focusSets = useMemo(
    () => (layout ? computeFocus(focus, layout.edges, appById) : null),
    [focus, layout, appById],
  );

  if (!layout) {
    return (
      <div className="border-2 border-fg bg-bg-raised shadow-neo p-10 text-center font-mono text-[10px] uppercase tracking-wider text-muted">
        No servers in fleet
      </div>
    );
  }

  const focusing = focus !== null;
  const layerOn = (k: EdgeKind) => (k === "tie" ? true : layers[k]);
  const nodeDim = (highlighted: boolean) => (focusing && !highlighted ? 0.28 : 1);

  const stats = {
    servers: data.servers.length,
    replicas: data.replicas.length,
    apps: data.apps.length,
    public: data.apps.filter((a) => a.public).length,
    sleeping: data.apps.filter((a) => a.status === "sleeping").length,
    links: layout.edges.filter((e) => e.kind === "env").length,
    stacks: new Set(data.apps.filter((a) => a.stack_id != null).map((a) => a.stack_id)).size,
  };

  const Toggle = ({ k, label, sw }: { k: keyof typeof layers; label: string; sw: string }) => {
    const on = layers[k];
    return (
      <button
        onClick={() => setLayers((s) => ({ ...s, [k]: !s[k] }))}
        className={`inline-flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider border-2 border-fg px-2.5 py-1.5 bg-bg-raised shadow-neo-sm transition-all active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none ${
          on ? "text-fg" : "text-muted"
        }`}
      >
        <span className="relative w-[22px] h-[13px] border-2 border-fg flex-shrink-0" style={{ background: on ? sw : "#F0EBE1" }}>
          <span
            className="absolute top-[1px] w-[7px] h-[7px] transition-transform"
            style={{ left: 1, transform: on ? "translateX(9px)" : "none", background: on ? "#fff" : "#8A8A8A" }}
          />
        </span>
        {label}
      </button>
    );
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <Toggle k="ing" label="Ingress · LB" sw="#5B8DEF" />
        <Toggle k="env" label="Env links" sw="#1A1A1A" />
        <Toggle k="wake" label="Wake proxy" sw="#FFB800" />
        <Toggle k="lab" label="Labels" sw="#BAFF39" />
        <div className="flex-1" />
        <div className="flex gap-3 items-center flex-wrap font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim">
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 border-[1.5px] border-fg bg-accent" /> Running</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 border-[1.5px] border-fg bg-accent-amber" /> Sleeping</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2" style={{ borderColor: "#5B8DEF" }} /> Traefik LB</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-fg" /> Env</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed" style={{ borderColor: "#FFB800" }} /> Wake</span>
        </div>
      </div>

      {/* Board */}
      <div ref={boardRef} className="border-2 border-fg bg-bg-raised shadow-neo overflow-x-auto">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b-2 border-fg bg-fg">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-accent">Fleet Graph</span>
          <span className="font-mono text-[9px] text-white/50 tracking-wide">
            — {stats.servers} servers · {stats.apps} apps · {stats.replicas} replicas · {stats.stacks} stack{stats.stacks === 1 ? "" : "s"} · ingress via Traefik
          </span>
          <div className="ml-auto flex gap-4 font-mono text-[9px] uppercase tracking-wider text-white/70">
            <span><b className="text-accent">{stats.public}</b> public</span>
            <span><b className="text-accent-amber">{stats.sleeping}</b> sleeping</span>
            <span><b className="text-white">{stats.links}</b> env links</span>
          </div>
        </div>

        <div
          className="p-3.5"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, transparent 0 23px, rgba(26,26,26,.028) 23px 24px), repeating-linear-gradient(90deg, transparent 0 23px, rgba(26,26,26,.028) 23px 24px)",
          }}
        >
          <div
            className="relative"
            style={{ width: layout.board.w, height: layout.board.h }}
            onClick={() => setSelected(null)}
          >
            {/* Edges (under nodes) */}
            <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none" style={{ zIndex: 1 }}>
              <defs>
                <marker id="ocd-ar-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5B8DEF" /></marker>
                <marker id="ocd-ar-dark" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#1A1A1A" /></marker>
                <marker id="ocd-ar-amber" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#FFB800" /></marker>
              </defs>
              {layout.edges.map((e) => {
                if (!layerOn(e.kind)) return null;
                const st = EDGE_STYLE[e.kind];
                const hi = focusSets?.edges.has(e.id) ?? false;
                const opacity = focusing ? (hi ? 1 : 0.12) : st.o;
                const width = focusing && hi ? st.w + 1.4 : st.w;
                return (
                  <path
                    key={e.id} d={roundedPath(e.pts)} fill="none"
                    stroke={st.c} strokeWidth={width} strokeDasharray={st.d}
                    markerEnd={st.m} style={{ opacity, transition: "opacity .12s, stroke-width .12s" }}
                  />
                );
              })}
            </svg>

            {/* Regions */}
            {layout.regions.map((r) => (
              <div
                key={r.id}
                className="absolute border-2 border-fg shadow-neo-sm"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h, background: r.ingress ? "#faf7ec" : "#F0EBE1", zIndex: 0 }}
              >
                <div className="absolute top-0 left-0 right-0 h-[30px] bg-fg flex items-center gap-2.5 px-3" style={{ zIndex: 2 }}>
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wide text-accent">{r.name}</span>
                  <span className="font-mono text-[9px] text-white/60 tracking-wide truncate">{r.meta}</span>
                  <span className="ml-auto font-mono text-[9px] font-bold uppercase text-fg bg-accent px-1.5 py-0.5 flex-shrink-0">{r.badge} replicas</span>
                </div>
              </div>
            ))}

            {/* Stack boxes */}
            {layout.stacks.map((s) => (
              <div
                key={s.key}
                className="absolute border-2 border-dashed border-fg"
                style={{ left: s.x, top: s.y, width: s.w, height: s.h, background: "rgba(186,255,57,.12)", zIndex: 0 }}
              >
                <span className="absolute left-3.5 font-mono text-[9px] font-bold uppercase tracking-wider text-fg bg-accent px-2 border-2 border-fg" style={{ top: -11 }}>
                  {s.label}
                </span>
              </div>
            ))}

            {/* Infra nodes */}
            {layout.infra.map((n) => {
              const hl = focusSets?.infra.has(n.key) ?? false;
              const style: React.CSSProperties = {
                left: n.rect.left, top: n.rect.top, width: n.rect.w, minHeight: n.rect.h,
                zIndex: 3, opacity: nodeDim(hl),
                background: n.key === "net" ? "#1A1A1A" : n.key === "pub" ? "#5B8DEF" : "#FFB800",
              };
              const nameColor = n.key === "waker" ? "text-fg" : n.key === "net" ? "text-accent" : "text-white";
              const subColor = n.key === "waker" ? "text-fg-dim" : "text-white/80";
              return (
                <button
                  key={n.key}
                  onMouseEnter={() => setHover({ type: "infra", id: n.key })}
                  onMouseLeave={() => setHover(null)}
                  onClick={(ev) => { ev.stopPropagation(); setSelected({ type: "infra", id: n.key }); }}
                  className={`absolute border-2 border-fg px-3 py-1.5 text-center cursor-pointer transition-[box-shadow,opacity] ${hl ? "shadow-neo" : "shadow-neo-sm"}`}
                  style={style}
                >
                  <div className={`font-mono text-[11px] font-bold uppercase tracking-wide ${nameColor}`}>{n.name}</div>
                  <div className={`font-mono text-[8.5px] tracking-wide mt-0.5 ${subColor}`}>{n.sub}</div>
                </button>
              );
            })}

            {/* App card fragments */}
            {layout.frags.map((f) => {
              const a = f.app;
              const running = a.status === "running";
              const sleeping = a.status === "sleeping";
              const hl = focusSets?.apps.has(a.id) ?? false;
              return (
                <button
                  key={f.key}
                  onMouseEnter={() => setHover({ type: "app", id: a.id })}
                  onMouseLeave={() => setHover(null)}
                  onClick={(ev) => { ev.stopPropagation(); setSelected({ type: "app", id: a.id }); }}
                  className={`absolute text-left border-2 border-fg cursor-pointer transition-[box-shadow,opacity] ${
                    sleeping ? "border-dashed" : ""
                  } ${hl ? "shadow-neo" : "shadow-neo-sm"}`}
                  style={{
                    left: f.rect.left, top: f.rect.top, width: f.rect.w, minHeight: f.rect.h,
                    zIndex: 2, opacity: nodeDim(hl), background: sleeping ? "#faf7ec" : "#fff",
                  }}
                >
                  <div className="flex items-center gap-1.5 px-2 py-1 border-b-2 border-fg">
                    <span className={`w-2 h-2 border-[1.5px] border-fg flex-shrink-0 ${running ? "bg-accent" : "bg-accent-amber"}`} />
                    <span className={`font-mono text-[11px] font-bold uppercase tracking-tight truncate ${sleeping ? "text-fg-dim" : "text-accent-blue"}`}>{a.name}</span>
                    {a.internal_port != null && <span className="font-mono text-[9px] text-muted flex-shrink-0">:{a.internal_port}</span>}
                    <span className="flex-1" />
                    {f.split && (
                      <span className="font-mono text-[8px] font-bold border-[1.5px] border-fg px-1 leading-[13px] text-accent-blue flex-shrink-0" style={{ background: "#eef4ff" }}>
                        {f.reps.length}/{f.total}
                      </span>
                    )}
                    <span className={`font-mono text-[8px] font-bold border-[1.5px] border-fg px-1 leading-[13px] uppercase flex-shrink-0 ${
                      a.public ? "bg-accent" : a.internal_protocol === "tcp" ? "bg-alt" : "bg-bg-raised"
                    }`}>
                      {a.public ? "PUB" : a.internal_protocol === "tcp" ? "TCP" : "PRIV"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 px-2 py-1.5">
                    {f.anchorOnly ? (
                      <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold border-[1.5px] border-fg px-1.5 py-0.5" style={{ background: "#F0EBE1" }}>
                        <span className="w-1.5 h-1.5 border border-fg bg-muted" />
                        <span className="text-muted font-normal">stopped</span>
                      </span>
                    ) : (
                      f.reps.map((r) => (
                        <span key={r.id} className="inline-flex items-center gap-1 font-mono text-[9px] font-bold border-[1.5px] border-fg bg-bg px-1.5 py-0.5">
                          <span className={`w-1.5 h-1.5 border border-fg ${r.status === "running" ? "bg-accent" : "bg-muted"}`} />
                          :{r.host_port ?? "—"}
                        </span>
                      ))
                    )}
                  </div>
                </button>
              );
            })}

            {/* Edge labels */}
            {layout.edges.map((e) => {
              if (!e.label || !layerOn(e.kind)) return null;
              const hi = focusSets?.edges.has(e.id) ?? false;
              const show = e.always || (focusing ? hi : layers.lab);
              if (!show) return null;
              const [lx, ly] = labelAt(e.pts);
              return (
                <div
                  key={`lab-${e.id}`}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 font-mono text-[8px] font-bold uppercase tracking-wide border-[1.5px] px-1.5 py-px whitespace-nowrap pointer-events-none ${labelClass[e.kind]}`}
                  style={{ left: lx, top: ly, zIndex: 5 }}
                >
                  {e.label}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Drawer */}
      <Drawer
        focus={selected} data={data} appById={appById} serverById={serverById}
        onClose={() => setSelected(null)}
        onSelectApp={(id) => setSelected({ type: "app", id })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------
function Drawer({
  focus, data, appById, serverById, onClose, onSelectApp,
}: {
  focus: FocusRef | null;
  data: TopologyData;
  appById: Map<number, TopologyApp>;
  serverById: Map<number, TopologyServer>;
  onClose: () => void;
  onSelectApp: (id: number) => void;
}) {
  const open = focus !== null;
  const app = focus?.type === "app" ? appById.get(focus.id) ?? null : null;
  const infraKey = focus?.type === "infra" ? focus.id : null;

  return (
    <aside
      className="fixed top-0 right-0 h-screen w-[352px] max-w-[90vw] bg-bg-raised border-l-2 border-fg overflow-y-auto z-[60] transition-transform duration-200"
      style={{ transform: open ? "none" : "translateX(100%)", boxShadow: "-6px 0 0 rgba(26,26,26,.12)" }}
    >
      <div className="sticky top-0 bg-fg px-4 py-3 flex items-start justify-between gap-2.5 z-[2]">
        <h2 className="font-mono text-sm font-bold uppercase tracking-wide text-accent break-all m-0">
          {app ? app.name : infraKey ?? ""}
        </h2>
        <button onClick={onClose} className="w-6 h-6 border-2 border-accent text-accent flex items-center justify-center flex-shrink-0" aria-label="Close">
          <X size={13} />
        </button>
      </div>
      <div className="p-4">
        {app && <AppDetail app={app} data={data} serverById={serverById} appById={appById} onSelectApp={onSelectApp} />}
        {infraKey && <InfraDetail infraKey={infraKey} data={data} serverById={serverById} />}
      </div>
    </aside>
  );
}

const badgeCls = "inline-flex items-center gap-1.5 font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-1.5 py-0.5";
const sectionCls = "font-mono text-[9px] font-bold uppercase tracking-[0.08em] text-fg border-b-2 border-fg pb-1.5 mb-2.5 mt-4 flex justify-between items-baseline";

function AppDetail({
  app, data, serverById, appById, onSelectApp,
}: {
  app: TopologyApp;
  data: TopologyData;
  serverById: Map<number, TopologyServer>;
  appById: Map<number, TopologyApp>;
  onSelectApp: (id: number) => void;
}) {
  const reps = data.replicas.filter((r) => r.app_id === app.id);
  const runningReps = reps.filter((r) => r.status === "running");
  const serverIds = [...new Set(reps.map((r) => r.server_id))];
  const spans = serverIds.length > 1;
  const outs = data.links.filter((l) => l.from === app.id);
  const ins = data.links.filter((l) => l.to === app.id);

  // Request path as a compact chip flow + qualifier tags (instead of prose).
  const flow = app.status === "sleeping"
    ? ["router", app.public ? "waker :8896" : "waker :21000+", "wakes on 1st req"]
    : app.public
      ? ["Internet :443", "ocd-traefik", `${runningReps.length} live`]
      : [`${app.name}.ocd.internal`, "local traefik", `${runningReps.length || "—"} live`];
  const tags = app.status === "sleeping"
    ? ["scaled to zero", "never 503"]
    : [
        ...(runningReps.length > 1 ? ["round-robin"] : []),
        ...(app.public && app.sticky ? ["sticky cookie"] : []),
        ...(spans ? ["cross-server"] : []),
      ];

  return (
    <>
      <div className="flex flex-wrap gap-1.5 mb-4">
        <span className={badgeCls}><StatusBadge status={app.status} /></span>
        {app.stack_name && <span className={badgeCls}>◆ {app.stack_name}</span>}
        <span className={badgeCls}>{app.public ? "◍ public" : "private"}</span>
        {app.internal_protocol === "tcp" && <span className={badgeCls}>tcp</span>}
        <span className={badgeCls}>{reps.length}× replica</span>
      </div>

      <dl className="grid gap-x-2.5 gap-y-1.5 mb-2" style={{ gridTemplateColumns: "72px 1fr" }}>
        {app.domain && (
          <>
            <dt className="font-mono text-[9px] font-bold uppercase tracking-wider text-muted pt-0.5">Domain</dt>
            <dd className="m-0 font-mono text-[11px] text-fg break-all">{app.domain}</dd>
          </>
        )}
        <dt className="font-mono text-[9px] font-bold uppercase tracking-wider text-muted pt-0.5">Internal</dt>
        <dd className="m-0 font-mono text-[11px] text-fg break-all">
          {app.internal_port != null ? (
            <>{app.internal_protocol}://{app.name}.ocd.internal:<span className="font-bold bg-accent px-1">{app.internal_port}</span></>
          ) : "—"}
        </dd>
      </dl>

      <p className={sectionCls}>Replicas <span className="text-muted">{runningReps.length} running</span></p>
      <table className="w-full border-collapse mb-3">
        <thead>
          <tr>
            {["Container", "Backend", "Server"].map((h) => (
              <th key={h} className="font-mono text-[8px] font-bold uppercase tracking-wider text-muted text-left px-1.5 py-1 border-b-2 border-fg">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reps.length === 0 ? (
            <tr><td colSpan={3} className="font-mono text-[10px] text-muted px-1.5 py-1.5">No replicas — woken on request.</td></tr>
          ) : (
            reps.map((r) => {
              const srv = serverById.get(r.server_id);
              const priv = srv?.private_ipv4;
              const backend = priv ? `${priv}:${r.host_port ?? "—"}` : `${r.host_port ?? "—"}`;
              return (
                <tr key={r.id}>
                  <td className="font-mono text-[10px] px-1.5 py-1 border-b border-fg/10 break-all">
                    <span className={`inline-block w-[7px] h-[7px] border border-fg mr-1 ${r.status === "running" ? "bg-accent" : "bg-muted"}`} />
                    {r.container_name}
                  </td>
                  <td className="font-mono text-[10px] px-1.5 py-1 border-b border-fg/10">{backend}</td>
                  <td className="font-mono text-[10px] px-1.5 py-1 border-b border-fg/10">{srv?.name ?? r.server_id}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <div className="border-2 border-fg bg-alt px-2.5 py-2 mb-2">
        <div className="flex items-center flex-wrap gap-1">
          {flow.map((n, i) => (
            <Fragment key={i}>
              {i > 0 && <span className="font-mono text-muted text-[11px] leading-none">→</span>}
              <span className="font-mono text-[9px] font-bold border-[1.5px] border-fg bg-bg-raised px-1.5 py-0.5">{n}</span>
            </Fragment>
          ))}
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {tags.map((t) => (
              <span key={t} className="font-mono text-[8px] font-bold uppercase tracking-wider border border-fg bg-accent px-1 py-px">{t}</span>
            ))}
          </div>
        )}
      </div>

      <p className={sectionCls}>Connects to <span className="text-muted">{outs.length}</span></p>
      {outs.length === 0 ? (
        <p className="font-mono text-[9px] text-muted mb-3">No outbound env links.</p>
      ) : outs.map((l, i) => {
        const peer = appById.get(l.to);
        return (
          <button key={i} onClick={() => onSelectApp(l.to)} className="w-full flex items-center gap-2 border-2 border-fg shadow-neo-sm px-2.5 py-1.5 mb-1.5 bg-bg-raised text-left transition-all hover:-translate-x-px hover:-translate-y-px hover:shadow-neo">
            <span className="font-mono text-[8px] font-bold uppercase text-fg bg-accent border-[1.5px] border-fg px-1 py-px">{l.key}</span>
            <span className="font-mono text-muted text-xs font-bold">→</span>
            <span className="font-mono text-[11px] font-bold uppercase text-accent-blue truncate">{peer?.name ?? l.to}</span>
          </button>
        );
      })}

      <p className={sectionCls}>Used by <span className="text-muted">{ins.length}</span></p>
      {ins.length === 0 ? (
        <p className="font-mono text-[9px] text-muted mb-3">Nothing depends on this app.</p>
      ) : ins.map((l, i) => {
        const peer = appById.get(l.from);
        return (
          <button key={i} onClick={() => onSelectApp(l.from)} className="w-full flex items-center gap-2 border-2 border-fg shadow-neo-sm px-2.5 py-1.5 mb-1.5 bg-bg-raised text-left transition-all hover:-translate-x-px hover:-translate-y-px hover:shadow-neo">
            <span className="font-mono text-[11px] font-bold uppercase text-accent-blue truncate">{peer?.name ?? l.from}</span>
            <span className="font-mono text-muted text-xs font-bold">→</span>
            <span className="font-mono text-[8px] font-bold uppercase text-white bg-accent-blue border-[1.5px] border-fg px-1 py-px">{l.key}</span>
          </button>
        );
      })}
    </>
  );
}

function InfraDetail({
  infraKey, data, serverById,
}: {
  infraKey: InfraKind;
  data: TopologyData;
  serverById: Map<number, TopologyServer>;
}) {
  const panel = data.panelServerId != null ? serverById.get(data.panelServerId) : undefined;
  const panelIp = panel?.ipv4 ?? "the panel IP";
  const notes: Record<InfraKind, string> = {
    pub: `ocd-traefik on the panel (host systemd). Terminates TLS on :443, matches Host() routers, and load-balances each app round-robin to private-ip:host-port over the private net — reaching replicas on any server. Every public domain's DNS points here.`,
    waker: `The waker runs in-process in the panel (not a container). Sleeping apps' routers repoint to ocd-waker-http:8896. It resolves by Host header, calls wakeApp(), holds until a replica runs, then forwards. First request slow, never a 503.`,
    net: `All public traffic enters on :443. DNS for every app domain resolves to the panel's public IP ${panelIp} — the single fleet ingress.`,
  };
  const sub: Record<InfraKind, string> = {
    net: "HTTPS :443",
    pub: `${panel?.name ?? "panel"} · :443 TLS`,
    waker: "ocd-waker-http :8896",
  };
  return (
    <>
      <div className="flex flex-wrap gap-1.5 mb-4">
        <span className={badgeCls}>infrastructure</span>
        <span className={`${badgeCls} bg-accent`}>{sub[infraKey]}</span>
      </div>
      <div className="font-mono text-[9px] text-fg-dim bg-alt border-2 border-fg px-2.5 py-2 leading-relaxed">{notes[infraKey]}</div>
    </>
  );
}
