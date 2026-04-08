import { useEffect, useState } from "react";
import { post } from "../api/client.ts";

export type ProgressEvent = { step: string; detail: string; ts: number };
export type DeployResult = { ok: boolean; error?: string } | null;

export type DeployState = {
  active: boolean;
  appName: string;
  progress: ProgressEvent[];
  result: DeployResult;
};

let state: DeployState = { active: false, appName: "", progress: [], result: null };
const listeners = new Set<() => void>();
let abortCtrl: AbortController | null = null;

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
  abortCtrl?.abort();
  abortCtrl = null;
  setState({ active: false, appName: "", progress: [], result: null });
}

export async function startDeploy(body: any): Promise<void> {
  abortCtrl?.abort();
  const ctrl = new AbortController();
  abortCtrl = ctrl;

  setState({ active: true, appName: body.app_name, progress: [], result: null });

  // Open SSE first so the server's progress listener is registered before
  // the deploy POST kicks off and starts emitting.
  const tokenRaw = localStorage.getItem("ocd-auth");
  const authToken = tokenRaw ? JSON.parse(tokenRaw).token : "";
  const streamUrl = `/api/apps/${encodeURIComponent(body.app_name)}/deploy/stream`;

  try {
    const streamRes = await fetch(streamUrl, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: ctrl.signal,
    });
    if (streamRes.ok && streamRes.body) {
      (async () => {
        const reader = streamRes.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              const data = JSON.parse(line.slice(5).trim());
              setState({
                ...state,
                progress: [...state.progress, { step: data.step, detail: data.detail, ts: Date.now() }],
              });
            } catch {}
          }
        }
      })().catch(() => {});
    }
  } catch {
    // stream setup failed — continue without live updates
  }

  try {
    const result = await post("/api/apps/deploy", body);
    setState({ ...state, result, active: false });
  } catch (err: any) {
    setState({ ...state, result: { ok: false, error: err.message }, active: false });
  } finally {
    if (abortCtrl === ctrl) {
      ctrl.abort();
      abortCtrl = null;
    }
  }
}
