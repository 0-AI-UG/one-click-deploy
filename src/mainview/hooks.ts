import { useState, useRef, useCallback } from "react";

export function useConfirmAction(action: () => Promise<void>, timeout = 2000) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const click = useCallback(async () => {
    if (busy) return;
    setError("");
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), timeout);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    try {
      await action();
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setBusy(false);
  }, [armed, busy, action, timeout]);

  return { armed, busy, click, error };
}
