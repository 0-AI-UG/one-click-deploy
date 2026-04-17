import Stripe from "stripe";
import { corsHeaders } from "../lib/cors.ts";
import { requireOrgContext, requireOrgOwner } from "../lib/org-context.ts";
import { handleError } from "../lib/utils.ts";
import {
  getStripeClient,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_PUBLISHABLE_KEY,
  APP_PUBLIC_HOST,
  invoiceSubscriptionId,
  periodEndIso,
  type ExpandedInvoice,
  type ExpandedSubscription,
} from "../lib/stripe.ts";
import * as db from "../../shared/db.ts";

const PRICE_PER_SEAT = 5;

const ACTIVE_STATUSES = new Set<string>(["active", "trialing"]);

type DefaultPM = { brand: string; last4: string; expMonth: number; expYear: number } | null;

async function getDefaultPaymentMethod(stripe: Stripe, customerId: string): Promise<DefaultPM> {
  const customer = await stripe.customers.retrieve(customerId, {
    expand: ["invoice_settings.default_payment_method"],
  });
  if ("deleted" in customer && customer.deleted) return null;
  const pm = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
  if (!pm || typeof pm === "string") return null;
  const card = (pm as Stripe.PaymentMethod).card;
  if (!card) return null;
  return {
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
  };
}

// GET /api/billing — billing status for current org
export async function handleGetBilling(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgContext(request);
    const apps = db.getApps(ctx.orgId);
    const members = db.getOrgMembers(ctx.orgId);
    const sub = db.getSubscription(ctx.orgId);

    let defaultPaymentMethod: DefaultPM = null;
    if (sub?.stripe_customer_id) {
      try {
        defaultPaymentMethod = await getDefaultPaymentMethod(getStripeClient(), sub.stripe_customer_id);
      } catch (err) {
        console.error(`[billing] failed to load default PM:`, err);
      }
    }

    return Response.json({
      required: apps.length > 1,
      status: sub?.status || "none",
      cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
      seatCount: members.length,
      appCount: apps.length,
      memberCount: members.length,
      pricePerSeat: PRICE_PER_SEAT,
      currentPeriodEnd: sub?.current_period_end || null,
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY || null,
      hasPaymentMethod: !!defaultPaymentMethod,
      defaultPaymentMethod,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/billing/subscribe — create incomplete subscription, return PaymentIntent client_secret
export async function handleSubscribe(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgOwner(request);
    // Fire-and-forget: registers our public host with Stripe's Apple Pay domain list on first run per process.
    ensureApplePayDomainRegistered();
    const stripe = getStripeClient();
    const members = db.getOrgMembers(ctx.orgId);
    const org = db.getOrg(ctx.orgId);
    const existingSub = db.getSubscription(ctx.orgId);

    // Reuse or create Stripe customer
    let customerId = existingSub?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { org_id: ctx.orgId, org_name: org?.name || "" },
      });
      customerId = customer.id;
    }

    // Resolve a client secret from a subscription's latest invoice across Stripe API versions.
    // Newer API versions expose `latest_invoice.confirmation_secret.client_secret`.
    // Older versions expose `latest_invoice.payment_intent.client_secret`.
    const extractClientSecret = (sub: ExpandedSubscription): string | null => {
      const inv = sub.latest_invoice;
      if (!inv || typeof inv === "string") return null;
      if (inv.confirmation_secret?.client_secret) return inv.confirmation_secret.client_secret;
      const pi = inv.payment_intent;
      if (pi && typeof pi !== "string" && pi.client_secret) return pi.client_secret;
      return null;
    };

    // If a usable subscription already exists with an open PaymentIntent, reuse it.
    // Only reuse when the PI is still confirmable — PIs in terminal states (succeeded/canceled)
    // cannot initialize Elements and will 400 on the client.
    const CONFIRMABLE_PI_STATUSES = new Set([
      "requires_payment_method",
      "requires_confirmation",
      "requires_action",
      "processing",
    ]);
    if (existingSub?.stripe_subscription_id && existingSub.status !== "canceled" && existingSub.status !== "none") {
      const sub = await stripe.subscriptions.retrieve(existingSub.stripe_subscription_id, {
        expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"],
      }) as unknown as ExpandedSubscription;
      const latestInvoice = typeof sub.latest_invoice === "object" && sub.latest_invoice ? sub.latest_invoice : null;
      const pi = latestInvoice?.payment_intent;
      const piStatus = pi && typeof pi !== "string" ? pi.status : null;
      const invoiceStatus = latestInvoice?.status;

      // Stripe says this subscription is already paid/active — sync DB and tell the client to close the modal.
      if (sub.status === "active" || sub.status === "trialing"
        || invoiceStatus === "paid" || piStatus === "succeeded") {
        db.updateSubscriptionStatus(
          ctx.orgId,
          sub.status === "trialing" ? "trialing" : "active",
          periodEndIso(sub),
        );
        return Response.json({
          subscriptionId: sub.id,
          alreadyActive: true,
          publishableKey: STRIPE_PUBLISHABLE_KEY,
        }, { headers: corsHeaders });
      }

      const cs = extractClientSecret(sub);
      if (cs && piStatus && CONFIRMABLE_PI_STATUSES.has(piStatus)) {
        return Response.json({
          subscriptionId: sub.id,
          clientSecret: cs,
          publishableKey: STRIPE_PUBLISHABLE_KEY,
        }, { headers: corsHeaders });
      }
      // Terminal or unusable PI on an incomplete sub — cancel and create a fresh one below
      try {
        await stripe.subscriptions.cancel(existingSub.stripe_subscription_id);
      } catch (err) {
        console.error("[billing] failed to cancel stale incomplete subscription:", err);
      }
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: STRIPE_PRICE_ID, quantity: members.length }],
      payment_behavior: "default_incomplete",
      payment_settings: {
        save_default_payment_method: "on_subscription",
        // Apple Pay / Google Pay ride on top of "card" automatically in the Payment Element
        // (requires the domain to be registered in Stripe Dashboard → Settings → Payment methods → Apple Pay).
        payment_method_types: ["card", "link", "klarna"],
      },
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"],
      metadata: { org_id: ctx.orgId },
    }) as unknown as ExpandedSubscription;

    const itemId = subscription.items.data[0]?.id || "";
    const periodEnd = periodEndIso(subscription) || new Date().toISOString();

    db.upsertSubscription(
      ctx.orgId,
      customerId,
      subscription.id,
      itemId,
      subscription.status || "incomplete",
      members.length,
      periodEnd,
    );

    // If the customer had a default PM and Stripe auto-charged the first invoice,
    // the subscription is already active/paid — no Elements flow needed.
    const newLatestInvoice = typeof subscription.latest_invoice === "object" && subscription.latest_invoice
      ? subscription.latest_invoice
      : null;
    const newInvoiceStatus = newLatestInvoice?.status;
    const newPi = newLatestInvoice?.payment_intent;
    const newPiStatus = newPi && typeof newPi !== "string" ? newPi.status : null;
    if (subscription.status === "active" || subscription.status === "trialing"
      || newInvoiceStatus === "paid" || newPiStatus === "succeeded") {
      return Response.json({
        subscriptionId: subscription.id,
        alreadyActive: true,
        publishableKey: STRIPE_PUBLISHABLE_KEY,
      }, { headers: corsHeaders });
    }

    let clientSecret = extractClientSecret(subscription);
    // Fallback: some accounts/API versions require an explicit invoice retrieve to surface the secret
    const invoiceIdForFallback = newLatestInvoice?.id;
    if (!clientSecret && invoiceIdForFallback) {
      const inv = await stripe.invoices.retrieve(invoiceIdForFallback, {
        expand: ["confirmation_secret", "payment_intent"],
      }) as unknown as ExpandedInvoice;
      if (inv.confirmation_secret?.client_secret) {
        clientSecret = inv.confirmation_secret.client_secret;
      } else if (inv.payment_intent && typeof inv.payment_intent !== "string" && inv.payment_intent.client_secret) {
        clientSecret = inv.payment_intent.client_secret;
      }
    }
    if (!clientSecret) {
      console.error("[billing] no client_secret on subscription", JSON.stringify({
        id: subscription.id,
        status: subscription.status,
        invoice: invoiceIdForFallback,
        invoiceStatus: newInvoiceStatus,
      }));
      return Response.json({ error: "Stripe did not return a client secret" }, { status: 500, headers: corsHeaders });
    }

    return Response.json({
      subscriptionId: subscription.id,
      clientSecret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/billing/payment-method/setup — create SetupIntent for updating card on file
export async function handleCreateSetupIntent(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgOwner(request);
    const sub = db.getSubscription(ctx.orgId);
    if (!sub?.stripe_customer_id) {
      return Response.json({ error: "No customer on file" }, { status: 400, headers: corsHeaders });
    }
    const stripe = getStripeClient();
    const setupIntent = await stripe.setupIntents.create({
      customer: sub.stripe_customer_id,
      payment_method_types: ["card"],
      usage: "off_session",
    });
    return Response.json({
      clientSecret: setupIntent.client_secret,
      publishableKey: STRIPE_PUBLISHABLE_KEY,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/billing/payment-method/attach — set the given PM as the default
export async function handleAttachPaymentMethod(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgOwner(request);
    const body = await request.json().catch(() => ({})) as { paymentMethodId?: string };
    const paymentMethodId = body.paymentMethodId;
    if (!paymentMethodId || typeof paymentMethodId !== "string" || !paymentMethodId.startsWith("pm_")) {
      return Response.json({ error: "paymentMethodId is required" }, { status: 400, headers: corsHeaders });
    }
    const sub = db.getSubscription(ctx.orgId);
    if (!sub?.stripe_customer_id) {
      return Response.json({ error: "No customer on file" }, { status: 400, headers: corsHeaders });
    }

    const stripe = getStripeClient();

    // Verify the PM belongs (or is attachable) to this customer's Stripe account.
    // If the PM is already attached to a *different* customer, reject — this
    // prevents an authenticated owner from accidentally (or maliciously)
    // referencing a PM id they learned elsewhere.
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    const pmCustomerId = typeof pm.customer === "string" ? pm.customer : pm.customer?.id ?? null;
    if (pmCustomerId && pmCustomerId !== sub.stripe_customer_id) {
      return Response.json({ error: "Payment method does not belong to this customer" }, { status: 403, headers: corsHeaders });
    }

    if (!pmCustomerId) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: sub.stripe_customer_id });
    }
    await stripe.customers.update(sub.stripe_customer_id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    if (sub.stripe_subscription_id) {
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        default_payment_method: paymentMethodId,
      });
    }
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// GET /api/billing/invoices — list recent invoices for the org's customer
export async function handleListInvoices(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgContext(request);
    const sub = db.getSubscription(ctx.orgId);
    if (!sub?.stripe_customer_id) {
      return Response.json({ invoices: [] }, { headers: corsHeaders });
    }
    const stripe = getStripeClient();
    const list = await stripe.invoices.list({ customer: sub.stripe_customer_id, limit: 12 });
    const invoices = list.data.map((inv: Stripe.Invoice) => ({
      id: inv.id,
      number: inv.number,
      amount: inv.amount_paid || inv.amount_due,
      currency: inv.currency,
      status: inv.status,
      created: new Date((inv.created || 0) * 1000).toISOString(),
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf,
    }));
    return Response.json({ invoices }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/billing/cancel — cancel subscription at period end
export async function handleCancelSubscription(request: Request): Promise<Response> {
  try {
    const ctx = await requireOrgOwner(request);
    const sub = db.getSubscription(ctx.orgId);
    if (!sub?.stripe_subscription_id) {
      return Response.json({ error: "No active subscription" }, { status: 400, headers: corsHeaders });
    }

    const stripe = getStripeClient();
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    // Reflect eagerly; the subsequent customer.subscription.updated webhook
    // will confirm but we want the UI to update immediately.
    db.setSubscriptionCancelAtPeriodEnd(ctx.orgId, true);

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// GET /.well-known/apple-developer-merchantid-domain-association
// Serves the Apple Pay domain association file required by Stripe to verify the domain.
// Stripe hosts the canonical file; we proxy and cache it with a TTL so a one-time
// transient error doesn't poison the cache for the life of the process.
const APPLE_DOMAIN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
let _appleDomainFile: { text: string; fetchedAt: number } | null = null;
export async function handleAppleDomainAssociation(_request: Request): Promise<Response> {
  const fresh = _appleDomainFile && Date.now() - _appleDomainFile.fetchedAt < APPLE_DOMAIN_TTL_MS;
  if (!fresh) {
    try {
      const res = await fetch("https://stripe.com/files/apple-pay/apple-developer-merchantid-domain-association");
      if (!res.ok) throw new Error(`stripe.com returned ${res.status}`);
      _appleDomainFile = { text: await res.text(), fetchedAt: Date.now() };
    } catch (err) {
      console.error("[billing] failed to fetch Apple Pay domain association:", err);
      // Fall back to a stale cached copy if we have one — better than a 502.
      if (!_appleDomainFile) {
        return new Response("Apple domain file unavailable", { status: 502 });
      }
    }
  }
  return new Response(_appleDomainFile!.text, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

// Platform-level Apple Pay domain registration.
// Runs once per process. Uses APP_PUBLIC_HOST env var as the source of truth —
// deriving from the request's Origin header would let any authenticated org
// owner pollute the platform's Stripe Apple Pay domain list with attacker-
// controlled hostnames.
let _applePayRegistered = false;
let _applePayRegistering: Promise<void> | null = null;
export async function ensureApplePayDomainRegistered(): Promise<void> {
  if (_applePayRegistered) return;
  if (_applePayRegistering) return _applePayRegistering;
  _applePayRegistering = (async () => {
    try {
      const host = APP_PUBLIC_HOST.trim();
      if (!host || host === "localhost" || host.startsWith("127.") || host.startsWith("0.") || host.startsWith("192.168.")) return;
      const stripe = getStripeClient();
      const existing = await stripe.applePayDomains.list({ limit: 100 });
      if (existing.data.some((d: Stripe.ApplePayDomain) => d.domain_name === host)) {
        _applePayRegistered = true;
        return;
      }
      await stripe.applePayDomains.create({ domain_name: host });
      console.log(`[billing] Registered Apple Pay domain: ${host}`);
      _applePayRegistered = true;
    } catch (err) {
      console.error("[billing] Apple Pay domain registration failed:", err);
    } finally {
      _applePayRegistering = null;
    }
  })();
  return _applePayRegistering;
}

// POST /webhooks/stripe — Stripe webhook handler
export async function handleStripeWebhook(request: Request): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  if (!sig) return Response.json({ error: "Missing signature" }, { status: 400 });

  const stripe = getStripeClient();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: Stripe retries deliveries on any non-2xx or slow response.
  // Mark-on-first-sight with INSERT OR IGNORE on event.id to make replays safe.
  const isNew = db.markStripeEventProcessed(event.id, event.type);
  if (!isNew) {
    return Response.json({ received: true, duplicate: true });
  }

  const eventCreated: number = typeof event.created === "number" ? event.created : Math.floor(Date.now() / 1000);

  try {
    switch (event.type) {
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as ExpandedInvoice;
        const subId = invoiceSubscriptionId(invoice);
        if (subId) {
          const subscription = await stripe.subscriptions.retrieve(subId) as unknown as ExpandedSubscription;
          const orgId = subscription.metadata?.org_id;
          if (orgId) {
            db.applySubscriptionEvent(
              orgId,
              "active",
              !!subscription.cancel_at_period_end,
              periodEndIso(subscription),
              eventCreated,
            );
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as ExpandedInvoice;
        const subId = invoiceSubscriptionId(invoice);
        if (subId) {
          const subscription = await stripe.subscriptions.retrieve(subId) as unknown as ExpandedSubscription;
          const orgId = subscription.metadata?.org_id;
          if (orgId) {
            db.applySubscriptionEvent(
              orgId,
              "past_due",
              !!subscription.cancel_at_period_end,
              periodEndIso(subscription),
              eventCreated,
            );
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as unknown as ExpandedSubscription;
        const orgId = subscription.metadata?.org_id;
        if (orgId) {
          db.applySubscriptionEvent(
            orgId,
            subscription.status,
            !!subscription.cancel_at_period_end,
            periodEndIso(subscription),
            eventCreated,
          );
        }
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object as unknown as ExpandedSubscription;
        const orgId = subscription.metadata?.org_id;
        if (orgId) {
          db.applySubscriptionEvent(
            orgId,
            "canceled",
            !!subscription.cancel_at_period_end,
            periodEndIso(subscription),
            eventCreated,
          );
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[billing] webhook handler for ${event.type} failed:`, err);
    // Don't 500 — that makes Stripe retry, and we've already marked the event
    // as processed. Log and move on; reconciliation jobs can catch drift.
  }

  return Response.json({ received: true });
}

// Sync subscription seat count when members change
export async function syncSubscriptionSeats(orgId: string): Promise<void> {
  const sub = db.getSubscription(orgId);
  if (!sub?.stripe_subscription_id || !sub.stripe_item_id) return;
  if (sub.status === "canceled" || sub.status === "none") return;

  const members = db.getOrgMembers(orgId);
  try {
    const stripe = getStripeClient();
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: sub.stripe_item_id, quantity: members.length }],
      proration_behavior: "create_prorations",
    });
    db.updateSubscriptionSeats(orgId, members.length);
  } catch (err) {
    console.error(`[billing] Failed to sync seats for org ${orgId}:`, err);
    throw err;
  }
}

export function hasActiveBilling(orgId: string): boolean {
  const sub = db.getSubscription(orgId);
  return !!sub && ACTIVE_STATUSES.has(sub.status);
}

/** Free tier is 1 app. Creating an app beyond the first requires active billing. */
export function canCreateApp(orgId: string): boolean {
  const apps = db.getApps(orgId);
  if (apps.length === 0) return true;
  return hasActiveBilling(orgId);
}

/** Existing apps can redeploy while an org is on the free tier (1 app).
 *  Once the org has >1 app, redeploys require active billing — so losing
 *  a subscription freezes redeploys without destroying running apps. */
export function canRedeployApp(orgId: string): boolean {
  const apps = db.getApps(orgId);
  if (apps.length <= 1) return true;
  return hasActiveBilling(orgId);
}
