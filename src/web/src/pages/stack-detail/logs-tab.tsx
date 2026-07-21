import { useState, useEffect, useMemo } from "react";
import { get } from "../../api/client.ts";
import { Card, Btn, Spinner } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { LogViewer } from "../../components/log-viewer.tsx";
import { ScrollText, RefreshCw } from "lucide-react";

type MemberLog = {
  kind: "app" | "service";
  id: number;
  name: string;
  logs: string;
  error?: string;
};

const keyOf = (m: MemberLog) => `${m.kind}-${m.id}`;

// Distinct hues, all legible on the log viewer's near-black and dark enough to
// take black text on the chips — the chip and the lines it controls carry the
// same colour, so the filter row doubles as the legend.
const MEMBER_COLORS = [
  "#5EEAD4", "#FFB800", "#7BABFF", "#C084FC",
  "#6EE7A0", "#FF8A5B", "#F472B6", "#FFD54F",
];

/**
 * One log stream for the whole stack.
 *
 * A stack is only interesting as a whole — a single request crosses several of
 * its apps and a database — so the useful unit is every member's output
 * interleaved chronologically, not one member at a time. The server fans out
 * once and returns timestamped blocks; merging and filtering happen here, so
 * muting a noisy member is instant and costs no round trip.
 *
 * The stack's own deploy narration (`stacks.deploy_log`) is a different kind of
 * text — written by `deploy_stack`, not by any container — so it is a separate
 * source rather than another line in the merge.
 */
export function StackLogsTab({ stackId }: { stackId: number }) {
  const [source, setSource] = useState<"live" | "deploy">("live");
  const [tail, setTail] = useState(100);
  const [members, setMembers] = useState<MemberLog[]>([]);
  const [muted, setMuted] = useState<Set<string>>(new Set());
  const [deployLog, setDeployLog] = useState("");
  const [loading, setLoading] = useState(false);

  const loadLive = async () => {
    setLoading(true);
    try {
      const res = await get(`/api/stacks/${stackId}/member-logs?tail=${tail}`) as { members?: MemberLog[] };
      setMembers(res.members || []);
    } catch (err) {
      setMembers([]);
      setDeployLog(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadDeploy = async () => {
    setLoading(true);
    try {
      const res = await get(`/api/stacks/${stackId}/log`);
      setDeployLog(res.log || "No deploy log recorded for this stack.");
    } catch (err) {
      setDeployLog(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (source === "live") loadLive(); else loadDeploy();
  }, [source, stackId, tail]);

  // Keyed by the name we print in the `[…]` prefix, and assigned by position in
  // the server's member list so a member keeps its colour across refreshes.
  const colorOf = useMemo(() => {
    const map: Record<string, string> = {};
    members.forEach((m, i) => { map[m.name] = MEMBER_COLORS[i % MEMBER_COLORS.length]; });
    return map;
  }, [members]);

  const merged = useMemo(() => {
    // `docker logs -t` prefixes every line with an RFC3339 timestamp, which is
    // what makes cross-member ordering meaningful. Continuation lines (stack
    // traces) carry no timestamp of their own, so they inherit the previous
    // line's — that keeps a trace glued to the line that opened it.
    type Line = { ts: string; seq: number; text: string };
    const lines: Line[] = [];
    let seq = 0;
    // Pad the prefixes to a common width so the messages themselves form a
    // column instead of stair-stepping with the length of each member's name.
    const shown = members.filter((m) => !muted.has(keyOf(m)));
    const width = Math.max(0, ...shown.map((m) => m.name.length));
    const tag = (name: string) => `[${name}]`.padEnd(width + 2) + " ";
    for (const m of shown) {
      let last = "";
      if (m.error) {
        lines.push({ ts: "", seq: seq++, text: `${tag(m.name)}log unavailable: ${m.error}` });
        continue;
      }
      for (const raw of m.logs.split("\n")) {
        if (!raw.trim()) continue;
        const sp = raw.indexOf(" ");
        const head = sp > 0 ? raw.slice(0, sp) : "";
        const stamped = /^\d{4}-\d{2}-\d{2}T/.test(head);
        if (stamped) last = head;
        lines.push({
          ts: stamped ? head : last,
          seq: seq++,
          text: `${(stamped ? head : last).slice(11, 23)} ${tag(m.name)}${stamped ? raw.slice(sp + 1) : raw}`,
        });
      }
    }
    lines.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
    return lines.map((l) => l.text).join("\n");
  }, [members, muted]);

  const toggle = (k: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <ScrollText size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">
            {source === "live" ? "Stack Logs" : "Stack Deploy Log"}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-36">
            <NeoSelect
              value={source}
              onChange={(v) => setSource(v as "live" | "deploy")}
              options={[
                { value: "live", label: "Container logs" },
                { value: "deploy", label: "Deploy log" },
              ]}
              compact
            />
          </div>
          {source === "live" && (
            <div className="w-24">
              <NeoSelect
                value={String(tail)}
                onChange={(v) => setTail(parseInt(v))}
                options={[50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} lines` }))}
                compact
              />
            </div>
          )}
          <Btn size="xs" loading={loading} onClick={() => (source === "live" ? loadLive() : loadDeploy())}>
            <RefreshCw size={12} /> Refresh
          </Btn>
        </div>
      </div>

      {source === "live" && members.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {members.map((m) => {
            const k = keyOf(m);
            const on = !muted.has(k);
            const color = colorOf[m.name];
            return (
              <button
                key={k}
                onClick={() => toggle(k)}
                title={m.error || `${m.kind} · ${on ? "shown" : "hidden"}`}
                style={on ? { backgroundColor: color } : undefined}
                className={`font-mono text-[9px] font-bold uppercase tracking-wider border-2 border-fg px-2 py-0.5 transition-all flex items-center gap-1.5 ${
                  on ? "text-[#111] shadow-neo-sm" : "bg-bg-raised text-muted"
                } ${m.error ? "line-through" : ""}`}
              >
                {!on && <span className="w-2 h-2 border border-fg/40" style={{ backgroundColor: color }} />}
                {m.name}
              </button>
            );
          })}
        </div>
      )}

      {loading && members.length === 0 && source === "live"
        ? <div className="flex justify-center py-10"><Spinner /></div>
        : <LogViewer logs={source === "live" ? merged : deployLog} tagColors={source === "live" ? colorOf : undefined} />}
    </Card>
  );
}
