import { useEffect, useState, useCallback } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { CreditCard, X, ShieldCheck } from "lucide-react";
import { Btn, Spinner, showToast } from "./ui.tsx";
import { get, post } from "../api/client.ts";
import { getStripePromise, stripeAppearance } from "../lib/stripe.ts";
import { errMsg } from "../lib/errors.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  onActive: () => void;
  seatCount: number;
  pricePerSeat: number;
};

type SubscribeResponse = {
  clientSecret?: string;
  publishableKey: string;
  subscriptionId: string;
  alreadyActive?: boolean;
};

export function BillingModal({ open, onClose, onActive, seatCount, pricePerSeat }: Props) {
  const [data, setData] = useState<SubscribeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    post("/api/billing/subscribe")
      .then((res: SubscribeResponse) => {
        if (res.alreadyActive) {
          showToast("Subscription active", "success");
          onActive();
          onClose();
          return;
        }
        setData(res);
      })
      .catch((err: unknown) => setError(errMsg(err) || "Failed to start checkout"))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const total = seatCount * pricePerSeat;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none animate-fade-in"
    >
      <div
        className="pointer-events-auto bg-bg-raised border-2 border-fg shadow-neo w-full max-w-md mx-4 animate-slide-up max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b-2 border-fg px-5 py-3">
          <div className="flex items-center gap-2">
            <CreditCard size={14} className="text-fg" />
            <h2 className="font-mono text-[10px] font-bold uppercase tracking-wider">Activate Subscription</h2>
          </div>
          <button onClick={onClose} className="text-fg-dim hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="border-2 border-fg/10 p-4 flex items-center justify-between">
            <div>
              <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim">Plan</div>
              <div className="font-mono text-sm font-bold mt-0.5">
                {seatCount} seat{seatCount !== 1 ? "s" : ""} × €{pricePerSeat}
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg-dim">Monthly</div>
              <div className="font-mono text-xl font-bold mt-0.5">€{total}</div>
            </div>
          </div>

          {loading && (
            <div className="flex justify-center py-8"><Spinner /></div>
          )}

          {error && !loading && (
            <div className="border-2 border-accent-red p-3">
              <p className="font-mono text-xs text-accent-red">{error}</p>
            </div>
          )}

          {data && data.clientSecret && !loading && (
            <Elements
              stripe={getStripePromise(data.publishableKey)}
              options={{ clientSecret: data.clientSecret, appearance: stripeAppearance }}
            >
              <SubscribeForm onActive={onActive} onClose={onClose} />
            </Elements>
          )}

          <div className="flex items-center gap-1.5 pt-1 text-fg-dim">
            <ShieldCheck size={11} />
            <span className="font-mono text-[9px] uppercase tracking-wider">Secured by Stripe · Cancel anytime</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SubscribeForm({ onActive, onClose }: { onActive: () => void; onClose: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const pollUntilActive = useCallback(async () => {
    for (let i = 0; i < 20; i++) {
      try {
        const res = await get<{ status?: string }>("/api/billing");
        if (res?.status === "active") return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 750));
    }
    return false;
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);

    const { error } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: {},
    });

    if (error) {
      setErrorMsg(error.message || "Payment failed");
      setSubmitting(false);
      return;
    }

    const active = await pollUntilActive();
    setSubmitting(false);
    if (active) {
      showToast("Subscription active", "success");
      onActive();
      onClose();
    } else {
      showToast("Payment received — finalizing in background", "success");
      onActive();
      onClose();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement options={{ layout: "tabs", wallets: { applePay: "auto", googlePay: "auto" } }} />
      {errorMsg && (
        <p className="font-mono text-[10px] text-accent-red">{errorMsg}</p>
      )}
      <Btn
        type="submit"
        variant="primary"
        className="w-full justify-center"
        loading={submitting}
        disabled={!stripe || !elements}
      >
        <CreditCard size={13} />
        Confirm & subscribe
      </Btn>
    </form>
  );
}
