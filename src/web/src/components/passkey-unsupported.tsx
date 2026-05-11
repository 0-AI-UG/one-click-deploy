import { Shield } from "lucide-react";
import { Card } from "./ui.tsx";

export function PasskeyUnsupported({ onBack }: { onBack?: () => void }) {
  return (
    <Card className="p-6 text-center">
      <Shield size={32} className="text-fg mx-auto mb-3" />
      <p className="font-mono text-[11px] font-bold uppercase text-fg mb-2">Passkeys are required</p>
      <p className="font-mono text-[10px] text-muted leading-relaxed">
        This browser does not support passkeys. Open the panel in a modern browser
        (Chrome, Safari, Edge, or Firefox) on a device with biometric unlock or a
        security key.
      </p>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mt-4 font-mono text-[9px] uppercase tracking-wider text-muted hover:text-fg underline"
        >
          Back to sign in
        </button>
      )}
    </Card>
  );
}
