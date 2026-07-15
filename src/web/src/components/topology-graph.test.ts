import { describe, expect, test } from "bun:test";
import {
  computeLayout,
  type TopologyApp,
  type TopologyData,
  type TopologyLink,
} from "./topology-graph.tsx";

const apps: TopologyApp[] = [
  { id: 1, name: "admin", status: "running", public: 1, domain: null, internal_port: 20012, internal_protocol: "http", sticky: false, stack_id: 1, stack_name: "demo", desired_replicas: 1 },
  { id: 2, name: "detect", status: "running", public: 0, domain: null, internal_port: 20013, internal_protocol: "http", sticky: false, stack_id: 1, stack_name: "demo", desired_replicas: 1 },
  { id: 3, name: "postgres", status: "running", public: 0, domain: null, internal_port: 20009, internal_protocol: "tcp", sticky: false, stack_id: 1, stack_name: "demo", desired_replicas: 1 },
  { id: 4, name: "web", status: "running", public: 1, domain: null, internal_port: 20010, internal_protocol: "http", sticky: false, stack_id: 1, stack_name: "demo", desired_replicas: 1 },
  { id: 5, name: "worker", status: "running", public: 0, domain: null, internal_port: 20011, internal_protocol: "http", sticky: false, stack_id: 1, stack_name: "demo", desired_replicas: 1 },
];

const links: TopologyLink[] = [
  { from: 1, to: 2, key: "DETECT_URL", sharedEnv: false },
  { from: 1, to: 3, key: "DATABASE_URL", sharedEnv: false },
  { from: 4, to: 2, key: "DETECT_URL", sharedEnv: false },
  { from: 4, to: 3, key: "DATABASE_URL", sharedEnv: false },
  { from: 4, to: 5, key: "WORKER_URL", sharedEnv: false },
  { from: 5, to: 2, key: "DETECT_URL", sharedEnv: false },
  { from: 5, to: 3, key: "DATABASE_URL", sharedEnv: false },
];

const data: TopologyData = {
  panelServerId: 1,
  servers: [
    { id: 1, name: "panel", ipv4: "203.0.113.1", private_ipv4: "10.0.0.1", type: "cx23", location: "fsn1", isPanel: true },
    { id: 2, name: "worker", ipv4: "203.0.113.2", private_ipv4: "10.0.0.2", type: "cx23", location: "fsn1", isPanel: false },
  ],
  apps,
  replicas: apps.map((app, index) => ({
    id: index + 1,
    app_id: app.id,
    server_id: app.id === 2 ? 2 : 1,
    host_port: 10_011 + index,
    status: "running",
    container_name: `${app.name}-1`,
  })),
  links,
};

const pointKey = ([x, y]: [number, number]) => `${x.toFixed(3)},${y.toFixed(3)}`;

describe("topology graph layout", () => {
  test("layers consumers above their dependencies and is deterministic", () => {
    const first = computeLayout(data, 1_100)!;
    const second = computeLayout({ ...data, apps: [...data.apps].reverse(), links: [...data.links].reverse() }, 1_100)!;
    const top = (layout: typeof first, id: number) => layout.frags.find((frag) => frag.app.id === id)!.rect.top;

    expect(top(first, 4)).toBeLessThan(top(first, 5));
    expect(top(first, 5)).toBeLessThan(top(first, 3));
    expect(first.frags.map((frag) => [frag.app.id, frag.rect.left, frag.rect.top]))
      .toEqual(second.frags.map((frag) => [frag.app.id, frag.rect.left, frag.rect.top]));
  });

  test("uses orthogonal routes and distinct boundary ports for high-degree nodes", () => {
    const layout = computeLayout(data, 1_100)!;
    const envEdges = layout.edges.filter((edge) => edge.kind === "env");
    for (const edge of envEdges) {
      for (let i = 1; i < edge.pts.length; i++) {
        const [x1, y1] = edge.pts[i - 1];
        const [x2, y2] = edge.pts[i];
        expect(x1 === x2 || y1 === y2).toBe(true);
      }
    }

    const webPorts = envEdges
      .filter((edge) => edge.appIds.includes(4))
      .flatMap((edge) => [edge.pts[0], edge.pts.at(-1)!])
      .filter(([x, y]) => {
        const rect = layout.frags.find((frag) => frag.app.id === 4)!.rect;
        return x >= rect.left && x <= rect.left + rect.w && y >= rect.top && y <= rect.top + rect.h;
      });
    expect(new Set(webPorts.map(pointKey)).size).toBe(webPorts.length);
  });

  test("keeps env segments out of unrelated app cards", () => {
    const layout = computeLayout(data, 1_100)!;
    const envEdges = layout.edges.filter((edge) => edge.kind === "env");
    const crossesInterior = (a: [number, number], b: [number, number], rect: (typeof layout.frags)[number]["rect"]) => {
      if (a[0] === b[0]) {
        const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
        return a[0] > rect.left && a[0] < rect.left + rect.w && hi > rect.top && lo < rect.top + rect.h;
      }
      const lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
      return a[1] > rect.top && a[1] < rect.top + rect.h && hi > rect.left && lo < rect.left + rect.w;
    };

    for (const edge of envEdges) {
      for (const frag of layout.frags.filter((frag) => !edge.appIds.includes(frag.app.id))) {
        for (let i = 1; i < edge.pts.length; i++) {
          expect(crossesInterior(edge.pts[i - 1], edge.pts[i], frag.rect)).toBe(false);
        }
      }
    }
  });
});
