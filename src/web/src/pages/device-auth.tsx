import { useState, useRef, useEffect } from "react";
import { post } from "../api/client.ts";
import { showToast, Card, Btn, AuthShell } from "../components/ui.tsx";
import { Terminal, Check } from "lucide-react";

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
    } catch (err: any) {
      showToast(err.message || "Invalid or expired code", "error");
    } finally {
      setLoading(false);
    }
  };

  if (confirmed) {
    return (
      <AuthShell icon={<Check size={32} />} title="CLI Authorized">
          <Card className="p-8 text-center">
            <p className="font-mono text-[11px] text-muted">You can close this page and return to your terminal.</p>
          </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell icon={<Terminal size={24} />} title="CLI Login">
        <Card className="p-4 sm:p-6">
          <p className="font-mono text-[11px] text-muted mb-5">Enter the code shown in your terminal to authorize the CLI.</p>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="flex items-center justify-center gap-0.5 sm:gap-1" onPaste={handlePaste}>
              {code.map((char, i) => (
                <span key={i} className="contents">
                  {i === 4 && <span className="mx-0.5 font-mono text-lg font-bold text-fg sm:mx-1">-</span>}
                  <input
                    ref={(el) => { inputRefs.current[i] = el; }}
                    type="text"
                    inputMode="text"
                    maxLength={1}
                    aria-label={`Code character ${i + 1}`}
                    value={char}
                    onChange={(e) => handleInput(i, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    className="h-11 !w-7 px-0 text-center font-mono text-lg font-bold uppercase text-fg transition-colors focus:border-accent focus:outline-none sm:!w-9"
                  />
                </span>
              ))}
            </div>
            <Btn
              type="submit"
              variant="primary"
              size="md"
              loading={loading}
              disabled={!isComplete}
              className="w-full justify-center"
            >
              Authorize CLI
            </Btn>
          </form>
        </Card>
    </AuthShell>
  );
}
