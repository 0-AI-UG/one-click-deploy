import { useEffect, useRef, useState } from "react";
import { useAuth } from "../stores/auth.ts";
import { Btn } from "../components/ui.tsx";
import { ArrowLeft } from "lucide-react";

type Props = {
  kind: "server" | "replica" | "service-instance";
  id: number;
};

export function TerminalPage({ kind, id }: Props) {
  const { token } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "connecting" | "open" | "closed" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    interface XTerm {
      cols: number; rows: number;
      loadAddon(addon: unknown): void;
      open(el: HTMLElement): void;
      focus(): void;
      write(data: string | Uint8Array): void;
      onData(cb: (data: string) => void): void;
      dispose(): void;
    }
    interface FitAddon { fit(): void; }
    let term: XTerm | undefined;
    let fitAddon: FitAddon | undefined;
    let ws: WebSocket | null = null;
    let disposed = false;

    (async () => {
      try {
        setStatus("loading");
        // Dynamic import from esm.sh to avoid adding a build-time dep.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        // @ts-ignore - CDN import
        const xterm = await import(/* @vite-ignore */ "https://esm.sh/xterm@5.3.0") as { Terminal: new (opts: Record<string, unknown>) => XTerm };
        // @ts-ignore - CDN import
        const fit = await import(/* @vite-ignore */ "https://esm.sh/xterm-addon-fit@0.8.0") as { FitAddon: new () => FitAddon };
        // Style (inject once)
        if (!document.getElementById("xterm-css")) {
          const link = document.createElement("link");
          link.id = "xterm-css";
          link.rel = "stylesheet";
          link.href = "https://esm.sh/xterm@5.3.0/css/xterm.css";
          document.head.appendChild(link);
        }

        if (disposed || !containerRef.current) return;
        term = new xterm.Terminal({
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          theme: { background: "#000000" },
          cursorBlink: true,
        });
        fitAddon = new fit.FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        fitAddon.fit();

        setStatus("connecting");
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const url = `${proto}://${window.location.host}/api/terminal/ws?target=${kind}:${id}&token=${encodeURIComponent(token || "")}`;
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          setStatus("open");
          term!.focus();
          // Send initial size
          try {
            ws!.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
          } catch { /* ws may not be open yet */ }
        };
        ws.onmessage = (ev) => {
          if (ev.data instanceof ArrayBuffer) {
            term!.write(new Uint8Array(ev.data));
          } else {
            term!.write(ev.data);
          }
        };
        ws.onclose = () => { setStatus("closed"); };
        ws.onerror = () => { setStatus("error"); setError("WebSocket error"); };

        const encoder = new TextEncoder();
        term.onData((data: string) => {
          // Send input as binary so the server can cleanly discriminate
          // keystrokes (bytes) from control frames (JSON strings).
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
        });

        const onResize = () => {
          try {
            fitAddon!.fit();
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resize", cols: term!.cols, rows: term!.rows }));
            }
          } catch { /* terminal may be disposed during resize */ }
        };
        window.addEventListener("resize", onResize);

        return () => window.removeEventListener("resize", onResize);
      } catch (err: any) {
        setStatus("error");
        setError(err?.message || String(err));
      }
    })();

    return () => {
      disposed = true;
      try { ws?.close(); } catch { /* cleanup, may already be closed */ }
      try { term?.dispose(); } catch { /* cleanup, may already be disposed */ }
    };
  }, [kind, id, token]);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-4">
        <Btn variant="ghost" onClick={() => window.history.back()}><ArrowLeft size={14} /></Btn>
        <h1 className="font-mono font-bold text-sm text-fg uppercase">
          Terminal — {kind} #{id}
        </h1>
        <span className="font-mono text-[9px] text-muted uppercase tracking-wider">{status}</span>
      </div>
      {error && <div className="font-mono text-[10px] text-red-500 mb-2">{error}</div>}
      <div
        ref={containerRef}
        className="border-2 border-fg bg-black"
        style={{ height: "70vh" }}
      />
    </div>
  );
}
