import db from "./connection.ts";

export type SubscriptionRow = {
  id: number;
  org_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_item_id: string;
  status: string; // 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled'
  seat_count: number;
  current_period_end: string;
  cancel_at_period_end: number;
  last_event_at: number;
  created_at: string;
  updated_at: string;
};

export function getSubscription(orgId: string): SubscriptionRow | null {
  return db.query("SELECT * FROM subscriptions WHERE org_id = ?").get(orgId) as SubscriptionRow | null;
}

export function upsertSubscription(
  orgId: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  stripeItemId: string,
  status: string,
  seatCount: number,
  currentPeriodEnd: string,
): void {
  db.query(
    `INSERT INTO subscriptions (org_id, stripe_customer_id, stripe_subscription_id, stripe_item_id, status, seat_count, current_period_end)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       stripe_item_id = excluded.stripe_item_id,
       status = excluded.status,
       seat_count = excluded.seat_count,
       current_period_end = excluded.current_period_end,
       updated_at = datetime('now')`,
  ).run(orgId, stripeCustomerId, stripeSubscriptionId, stripeItemId, status, seatCount, currentPeriodEnd);
}

export function updateSubscriptionStatus(orgId: string, status: string, currentPeriodEnd?: string): void {
  if (currentPeriodEnd) {
    db.query("UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = datetime('now') WHERE org_id = ?").run(
      status,
      currentPeriodEnd,
      orgId,
    );
  } else {
    db.query("UPDATE subscriptions SET status = ?, updated_at = datetime('now') WHERE org_id = ?").run(status, orgId);
  }
}

/** Apply a subscription.updated / created payload, rejecting stale events.
 *  Returns true if the row was updated, false if the event was older than
 *  what we already have on file. */
export function applySubscriptionEvent(
  orgId: string,
  status: string,
  cancelAtPeriodEnd: boolean,
  currentPeriodEnd: string | undefined,
  eventCreated: number,
): boolean {
  // Only overwrite if the incoming event is newer than the last one we
  // processed for this subscription. Stripe doesn't guarantee delivery order.
  const result = db.query(
    `UPDATE subscriptions
       SET status = ?,
           cancel_at_period_end = ?,
           current_period_end = COALESCE(NULLIF(?, ''), current_period_end),
           last_event_at = ?,
           updated_at = datetime('now')
     WHERE org_id = ? AND last_event_at <= ?`,
  ).run(status, cancelAtPeriodEnd ? 1 : 0, currentPeriodEnd || "", eventCreated, orgId, eventCreated);
  return (result as { changes: number }).changes > 0;
}

export function setSubscriptionCancelAtPeriodEnd(orgId: string, value: boolean): void {
  db.query("UPDATE subscriptions SET cancel_at_period_end = ?, updated_at = datetime('now') WHERE org_id = ?").run(
    value ? 1 : 0,
    orgId,
  );
}

export function updateSubscriptionSeats(orgId: string, seatCount: number): void {
  db.query("UPDATE subscriptions SET seat_count = ?, updated_at = datetime('now') WHERE org_id = ?").run(seatCount, orgId);
}

/** Returns true if this is the first time we've seen this Stripe event.id.
 *  Uses INSERT OR IGNORE so concurrent webhook deliveries race safely. */
export function markStripeEventProcessed(eventId: string, eventType: string): boolean {
  const result = db.query(
    "INSERT OR IGNORE INTO stripe_processed_events (event_id, event_type) VALUES (?, ?)",
  ).run(eventId, eventType);
  return (result as { changes: number }).changes > 0;
}
