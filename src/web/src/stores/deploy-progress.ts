import { useEffect, useState } from "react";
import { post, get } from "../api/client.ts";
import type { DeployBody } from "../types.ts";

export type ProgressEvent = { step: string; detail: string; ts: number };
export type DeployResult = { ok: boolean; error?: string } | null;

export type DeployState = {
  active: boolean;
  jobId: number | null;
  appName: string;
  progress: ProgressEvent[];
  result: DeployResult;
};

let state: DeployState = {
  active: false,
  jobId: null,
  appName: "",
  progress: [],
  result: null,
};
const listeners = new Set<() => void>();
let pollGen = 0; // bumped on clearDeploy/startDeploy/resumeDeploy to cancel in-flight loops

function setState(next: DeployState) {
  state = next;
  listeners.forEach((l) => l());
}

export function getDeployState(): DeployState {
  return state;
}

export function useDeployProgress(): DeployState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return state;
}

export function clearDeploy() {
  pollGen++;
  setState({ active: false, jobId: null, appName: "", progress: [], result: null });
}

type PollResponse = {
  status: "running" | "done" | "error";
  events: Array<{ seq: number; ts: string; step: string; detail: string }>;
  last_seq: number;
  result: { ok: boolean; error?: string } | null;
};

async function pollLoop(jobId: number, myGen: number): Promise<void> {
  let since = 0;
  while (myGen === pollGen) {
    let resp: PollResponse;
    try {
      resp = (await get(`/api/deploy-jobs/${jobId}?since=${since}`)) as PollResponse;
    } catch (err: any) {
      if (myGen !== pollGen) return;
      // 404 → job no longer exists; surface as error and stop.
      if (/not found/i.test(err?.message || "")) {
        setState({ ...state, result: { ok: false, error: "Deploy job not found" }, active: false });
        return;
      }
      // Transient network error — back off briefly and retry.
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (myGen !== pollGen) return;

    if (resp.events.length > 0) {
      const newEvents: ProgressEvent[] = resp.events.map((e) => ({
        step: e.step,
        detail: e.detail,
        ts: Date.parse(e.ts + "Z") || Date.now(),
      }));
      setState({ ...state, progress: [...state.progress, ...newEvents] });
      since = resp.last_seq;
    }

    if (resp.status !== "running") {
      setState({ ...state, result: resp.result, active: false });
      return;
    }
  }
}

export async function startDeploy(body: DeployBody): Promise<void> {
  const myGen = ++pollGen;
  setState({
    active: true,
    jobId: null,
    appName: body.app_name,
    progress: [],
    result: null,
  });

  let jobId: number;
  try {
    const res = (await post("/api/apps/deploy", body)) as { deployment_id: number };
    jobId = res.deployment_id;
  } catch (err: any) {
    if (myGen !== pollGen) return;
    setState({ ...state, result: { ok: false, error: err.message }, active: false });
    return;
  }
  if (myGen !== pollGen) return;

  setState({ ...state, jobId });
  // Replace URL so reload resumes the same job.
  history.replaceState(null, "", `#/deploy/progress/${jobId}`);

  await pollLoop(jobId, myGen);
}

// Resume watching an existing deploy job (e.g. after a page reload).
export function resumeDeploy(jobId: number): void {
  if (state.jobId === jobId && (state.active || state.result)) {
    // Already watching (or have a final result for) this job — nothing to do.
    return;
  }
  const myGen = ++pollGen;
  setState({
    active: true,
    jobId,
    appName: "",
    progress: [],
    result: null,
  });
  void pollLoop(jobId, myGen);
}
