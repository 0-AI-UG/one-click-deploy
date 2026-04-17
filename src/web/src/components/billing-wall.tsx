import { useState } from "react";
import { CreditCard } from "lucide-react";
import { Btn } from "./ui.tsx";
import { BillingModal } from "./billing-modal.tsx";

type Props = {
  appCount: number;
  seatCount: number;
  pricePerSeat: number;
  onActivated?: () => void;
};

export function BillingWall({ appCount, seatCount, pricePerSeat, onActivated }: Props) {
  const [open, setOpen] = useState(false);
  const total = seatCount * pricePerSeat;

  return (
    <div className="max-w-lg mx-auto px-4 py-20 text-center animate-fade-in">
      <div className="border-2 border-fg p-8 space-y-5">
        <CreditCard size={28} className="mx-auto text-fg" />
        <h2 className="font-mono text-sm font-bold text-fg uppercase">Subscription Required</h2>
        <p className="font-mono text-xs text-fg-dim leading-relaxed">
          Your organization has {appCount} app{appCount !== 1 ? "s" : ""}. A subscription is required
          to deploy or redeploy when you have more than one app.
        </p>
        <p className="font-mono text-sm font-bold text-fg">
          {seatCount} seat{seatCount !== 1 ? "s" : ""} &times; &euro;{pricePerSeat} = &euro;{total}/month
        </p>
        <Btn
          variant="primary"
          className="w-full justify-center"
          onClick={() => setOpen(true)}
        >
          <CreditCard size={13} />
          Activate now
        </Btn>
      </div>

      <BillingModal
        open={open}
        onClose={() => setOpen(false)}
        onActive={() => onActivated?.()}
        seatCount={seatCount}
        pricePerSeat={pricePerSeat}
      />
    </div>
  );
}
