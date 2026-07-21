import { useEffect, useRef, useMemo } from "react";
import { Spinner } from "./ui.tsx";

// ANSI color code to CSS color mapping
const ANSI_COLORS: Record<number, string> = {
  30: "#4A4A4A", 31: "#FF4444", 32: "#4ADE80", 33: "#FFB800",
  34: "#5B8DEF", 35: "#C084FC", 36: "#22D3EE", 37: "#E5E5E5",
  90: "#8A8A8A", 91: "#FF6B6B", 92: "#6EE7A0", 93: "#FFD54F",
  94: "#7BABFF", 95: "#D8A8FF", 96: "#5EEAD4", 97: "#FFFFFF",
};

interface Span {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

function parseAnsi(raw: string): Span[] {
  const spans: Span[] = [];
  let color: string | undefined;
  let bold = false;
  let dim = false;
  // eslint-disable-next-line no-control-regex
  const parts = raw.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) spans.push({ text: parts[i], color, bold, dim });
    } else {
      const codes = parts[i].split(";").map(Number);
      for (const c of codes) {
        if (c === 0) { color = undefined; bold = false; dim = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (ANSI_COLORS[c]) color = ANSI_COLORS[c];
        else if (c === 39) color = undefined;
      }
    }
  }
  return spans;
}

// Detect log level keywords and assign colors
const LEVEL_PATTERNS: [RegExp, string][] = [
  [/\b(ERROR|FATAL|PANIC|CRIT)\b/i, "#FF4444"],
  [/\b(WARN|WARNING)\b/i, "#FFB800"],
  [/\b(INFO)\b/i, "#5B8DEF"],
  [/\b(DEBUG|TRACE)\b/i, "#8A8A8A"],
];

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.Z+:-]*)\s*/;
// A merged multi-source log (a stack's members) prefixes every line with the
// source it came from, after the timestamp: `13:48:43.435 [bc-postgres] …`.
// The trailing run of spaces is padding the caller added to align the messages,
// so it is captured and re-emitted rather than collapsed.
const TAG_RE = /^(\d{2}:\d{2}:\d{2}[.\d]*\s)?\[([^\]\s]+)\](\s+)/;

function colorizeLine(line: string, tagColors?: Record<string, string>): { spans: Span[]; tag?: string } {
  // First check if line has ANSI codes
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(line)) {
    return { spans: parseAnsi(line) };
  }

  const spans: Span[] = [];

  // Extract and dim the timestamp
  const tsMatch = line.match(TIMESTAMP_RE);
  if (tsMatch) {
    spans.push({ text: tsMatch[1], color: "#8A8A8A" });
    line = line.slice(tsMatch[0].length);
    spans.push({ text: " " });
  }

  // Pull the source tag out and give it the source's own colour, so a wall of
  // interleaved lines can be read by hue instead of by parsing each prefix.
  let tag: string | undefined;
  if (tagColors) {
    const m = line.match(TAG_RE);
    if (m && tagColors[m[2]]) {
      tag = m[2];
      if (m[1]) spans.push({ text: m[1], color: "#8A8A8A" });
      spans.push({ text: `[${tag}]`, color: tagColors[tag], bold: true });
      spans.push({ text: m[3] });
      line = line.slice(m[0].length);
    }
  }

  // Check for log level and color the whole remaining line accordingly
  let levelColor: string | undefined;
  for (const [re, color] of LEVEL_PATTERNS) {
    if (re.test(line)) {
      levelColor = color;
      break;
    }
  }

  if (levelColor) {
    spans.push({ text: line, color: levelColor });
  } else {
    spans.push({ text: line });
  }

  return { spans, tag };
}

function renderSpans(spans: Span[]) {
  return spans.map((s, i) => {
    if (!s.color && !s.bold && !s.dim) return s.text;
    const style: React.CSSProperties = {};
    if (s.color) style.color = s.color;
    if (s.bold) style.fontWeight = 700;
    if (s.dim) style.opacity = 0.6;
    return <span key={i} style={style}>{s.text}</span>;
  });
}

interface LogViewerProps {
  logs: string;
  className?: string;
  /** Colour per `[tag]` prefix, for logs merged from several sources. */
  tagColors?: Record<string, string>;
}

export function LogViewer({ logs, className, tagColors }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);

  // Track if user was scrolled to bottom before update
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasAtBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  };

  const rendered = useMemo(() => {
    if (!logs) return null;
    const lines = logs.split("\n");
    return lines.map((line, i) => {
      const { spans, tag } = colorizeLine(line, tagColors);
      return (
        // The gutter bar carries the colour down continuation lines, which have
        // no prefix of their own — a wrapped stack trace stays visibly one source.
        <div
          key={i}
          className="log-line"
          style={tag ? { borderLeftColor: tagColors![tag] } : undefined}
        >
          {renderSpans(spans)}
        </div>
      );
    });
  }, [logs, tagColors]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={`bg-[#111] border-2 border-fg rounded p-3 max-h-[500px] overflow-auto font-mono text-[11px] leading-[1.6] text-[#ccc] ${className || ""}`}
      style={{ tabSize: 4 }}
    >
      {rendered || <span className="text-muted inline-flex items-center gap-1.5"><Spinner className="w-3 h-3" />Loading</span>}
      <style>{`
        .log-line:hover { background: rgba(255,255,255,0.04); }
        .log-line { padding: 0 4px; white-space: pre-wrap; word-break: break-all; border-left: 2px solid transparent; }
      `}</style>
    </div>
  );
}
