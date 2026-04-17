import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
    // Do NOT pin apiVersion here — the SDK will request its own pinned default,
    // which matches the types shipped with the installed stripe-node version.
    // We defensively read from both old and new field paths in billing.ts so
    // the webhook keeps working across account-level API version upgrades.
    _stripe = new Stripe(key);
  }
  return _stripe;
}

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
/** Public hostname of the panel. Used for Apple Pay domain registration — we
 *  cannot trust the request's Origin header for this because any authenticated
 *  org admin could forge it and pollute the platform's Stripe domain list. */
export const APP_PUBLIC_HOST = process.env.APP_PUBLIC_HOST || "";

// Fields that exist on newer Stripe API versions but may not be present on the
// types shipped with the installed stripe-node version. Narrow, explicit, and
// local so the rest of the code can stay strictly typed.
export type ExpandedInvoice = Stripe.Invoice & {
  confirmation_secret?: { client_secret: string | null } | null;
  payment_intent?: string | Stripe.PaymentIntent | null;
  subscription?: string | Stripe.Subscription | null;
  parent?: {
    subscription_details?: { subscription?: string | Stripe.Subscription | null } | null;
  } | null;
};

export type ExpandedSubscriptionItem = Stripe.SubscriptionItem & {
  current_period_end?: number | null;
};

export type ExpandedSubscription = Omit<Stripe.Subscription, "latest_invoice" | "items"> & {
  current_period_end?: number | null;
  latest_invoice?: string | ExpandedInvoice | null;
  items: { data: ExpandedSubscriptionItem[] };
};

/** Extract a subscription id from an invoice across Stripe API versions.
 *  Older: invoice.subscription is a string id.
 *  Newer: invoice.parent.subscription_details.subscription. */
export function invoiceSubscriptionId(invoice: ExpandedInvoice | null | undefined): string | null {
  if (!invoice) return null;
  const direct = invoice.subscription;
  if (typeof direct === "string" && direct) return direct;
  if (direct && typeof direct === "object" && "id" in direct && direct.id) return direct.id;
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === "string" && fromParent) return fromParent;
  if (fromParent && typeof fromParent === "object" && "id" in fromParent && fromParent.id) return fromParent.id;
  return null;
}

/** Extract current_period_end (unix seconds) from a subscription across API
 *  versions. Older: subscription.current_period_end. Newer: on items. */
export function subscriptionPeriodEnd(sub: ExpandedSubscription | null | undefined): number | null {
  if (!sub) return null;
  if (typeof sub.current_period_end === "number") return sub.current_period_end;
  const item = sub.items?.data?.[0];
  if (item && typeof item.current_period_end === "number") return item.current_period_end;
  return null;
}

export function periodEndIso(sub: ExpandedSubscription | null | undefined): string | undefined {
  const sec = subscriptionPeriodEnd(sub);
  return sec ? new Date(sec * 1000).toISOString() : undefined;
}
