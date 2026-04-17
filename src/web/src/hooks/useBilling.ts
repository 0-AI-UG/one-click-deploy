import { useState, useEffect } from "react";
import { get } from "../api/client.ts";

export type DefaultPaymentMethod = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type BillingStatus = {
  required: boolean;
  status: string;
  cancelAtPeriodEnd: boolean;
  seatCount: number;
  appCount: number;
  memberCount: number;
  pricePerSeat: number;
  currentPeriodEnd: string | null;
  stripePublishableKey: string | null;
  hasPaymentMethod: boolean;
  defaultPaymentMethod: DefaultPaymentMethod | null;
};

export function useBilling() {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    get("/api/billing")
      .then(setBilling)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { reload(); }, []);

  return { billing, loading, reload };
}
