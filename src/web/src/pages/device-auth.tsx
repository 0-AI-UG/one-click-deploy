import { useState, useRef, useEffect } from "react";
import { post } from "../api/client.ts";
import { showToast, Spinner } from "../components/ui.tsx";
import { Terminal, Check } from "lucide-react";
import { errMsg } from "../lib/errors.ts";

export function DeviceAuthPage() {
  const [code, setCode] = useState(["", "", "", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const fullCode = code.slice(0, 4).join("") + "-" + code.slice(4).join("");
  const isComplete = code.every((c) => c !== "");

  const handleInput = (index: number, value: string) => {
    const char = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-1);
    const next = [...code];
    next[index] = char;
    setCode(next);

    if (char && index < 7) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const chars = text.slice(0, 8).split("");
    const next = [...code];
    chars.forEach((ch, i) => { next[i] = ch; });
    setCode(next);
    const focusIdx = Math.min(chars.length, 7);
    inputRefs.current[focusIdx]?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isComplete) return;
    setLoading(true);
    try {
      await post("/api/auth/device-confirm", { user_code: fullCode });
      setConfirmed(true);
    } catch (err) {
      showToast(errMsg(err) || "Invalid or expired code", "error");
    } finally {
      setLoading(false);
    }
  };

  if (confirmed) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-sm animate-slide-up text-center">
          <div className="bg-bg-raised border-2 border-fg shadow-neo p-8">
            <Check size={32} className="text-green-600 mx-auto mb-4" />
            <h2 className="font-mono text-sm font-bold text-fg uppercase mb-2">CLI Authorized</h2>
            <p className="font-mono text-[11px] text-muted">You can close this page and return to your terminal.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <Terminal size={24} className="text-fg" />
          <h1 className="font-mono font-bold text-lg text-fg tracking-wider uppercase">CLI Login</h1>
        </div>
        <div className="bg-bg-raised border-2 border-fg shadow-neo p-6">
          <p className="font-mono text-[11px] text-muted mb-5">Enter the code shown in your terminal to authorize the CLI.</p>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="flex items-center justify-center gap-1" onPaste={handlePaste}>
              {code.map((char, i) => (
                <span key={i} className="contents">
                  {i === 4 && <span className="font-mono text-fg font-bold text-lg mx-1">-</span>}
                  <input
                    ref={(el) => { inputRefs.current[i] = el; }}
                    type="text"
                    inputMode="text"
                    maxLength={1}
                    value={char}
                    onChange={(e) => handleInput(i, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    className="w-9 h-11 text-center font-mono text-lg font-bold uppercase border-2 border-fg bg-bg text-fg focus:border-accent focus:outline-none transition-colors"
                  />
                </span>
              ))}
            </div>
            <button
              type="submit"
              disabled={!isComplete || loading}
              className="w-full flex items-center justify-center gap-2 bg-accent text-fg border-2 border-fg shadow-neo-sm hover:shadow-neo hover:-translate-x-px hover:-translate-y-px active:translate-x-0.5 active:translate-y-0.5 active:shadow-neo-none px-4 py-2.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-all disabled:opacity-35"
            >
              {loading ? <Spinner /> : "Authorize CLI"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
