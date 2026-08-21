/**
 * Self-service billing arithmetic (ADR 0024).
 *
 * Pure, and separated from everything that talks to Paystack, for the reason
 * the rest of this codebase separates money from I/O: these are the figures a
 * merchant is charged, and a figure that can only be checked by making a
 * network call is a figure nobody checks.
 *
 * The terms themselves are Angelo's, recorded in ADR 0024. This file
 * implements them and does not decide them.
 */
import { PLAN_PRICES_K, type PlanId } from './allowances.js';
import { mintReference, type RandomBytes } from './payments.js';
import type { UsageUnit } from './allowances.js';

/** A Lagos day, in milliseconds. Lagos is fixed UTC+1 with no daylight saving. */
const DAY_MS = 86_400_000;

/* ── what kind of change is this ──────────────────────────────────────────── */

export type PlanChangeKind =
  /** Coming from trial or expired: there is no cycle to prorate against. */
  'first_purchase' | 'upgrade' | 'downgrade' | 'same';

/**
 * Classify by PRICE rather than by a hand-written ladder.
 *
 * Integrate (₦19,900) and Chat (₦9,900) are not two rungs of one ladder, they
 * are different products, and a table saying which is "above" the other would
 * be a second source of truth to keep in step with the prices. What the
 * merchant is charged depends only on whether the new plan costs more.
 */
export function planChangeKind(from: string, to: string): PlanChangeKind {
  const fromK = PLAN_PRICES_K[from as PlanId] ?? 0;
  const toK = PLAN_PRICES_K[to as PlanId] ?? 0;
  if (fromK === 0) return toK === 0 ? 'same' : 'first_purchase';
  if (toK > fromK) return 'upgrade';
  if (toK < fromK) return 'downgrade';
  return 'same';
}

/* ── what it costs today ──────────────────────────────────────────────────── */

export interface PlanChangeCharge {
  kind: PlanChangeKind;
  /** Charged now, in kobo. Zero for a downgrade and for no change. */
  amountK: number;
  /** When the new plan starts working. */
  effectiveFrom: 'now' | 'next_renewal';
  /** The renewal date after this change. Unchanged by an upgrade. */
  renewsAt: Date;
}

/**
 * What a plan change costs, and when it takes effect (ADR 0024).
 *
 * An upgrade charges the prorated DIFFERENCE and leaves the renewal date
 * alone, so the merchant is never asked to hold two dates in their head. A
 * downgrade charges nothing and waits: crediting the unused part of a plan
 * they already paid for would mean carrying a balance, and a balance is a
 * number that has to be explained on WhatsApp.
 *
 * Coming from trial or expired there is no cycle to prorate against, so the
 * full price is charged and the cycle starts now.
 *
 * Rounded DOWN. The difference between rounding modes is a few kobo, and the
 * direction that can only ever undercharge is the one to take when the other
 * party did not choose the formula.
 */
export function planChangeCharge(input: {
  from: string;
  to: string;
  /** Start of the cycle the merchant is currently in. */
  cycleStart: Date;
  /** When that cycle renews. */
  renewsAt: Date;
  now: Date;
}): PlanChangeCharge {
  const kind = planChangeKind(input.from, input.to);
  const toK = PLAN_PRICES_K[input.to as PlanId] ?? 0;

  if (kind === 'same') {
    return { kind, amountK: 0, effectiveFrom: 'now', renewsAt: input.renewsAt };
  }

  if (kind === 'downgrade') {
    /* Nothing to pay and nothing to refund. They keep what they bought until
     * it runs out, and the cheaper plan begins when the next one would have. */
    return { kind, amountK: 0, effectiveFrom: 'next_renewal', renewsAt: input.renewsAt };
  }

  if (kind === 'first_purchase') {
    return {
      kind,
      amountK: toK,
      effectiveFrom: 'now',
      renewsAt: addMonth(input.now),
    };
  }

  const fromK = PLAN_PRICES_K[input.from as PlanId] ?? 0;
  const differenceK = toK - fromK;
  const total = wholeDaysBetween(input.cycleStart, input.renewsAt);
  const remaining = wholeDaysBetween(input.now, input.renewsAt);

  /**
   * A cycle with no days left, or none at all, charges nothing rather than
   * dividing by zero. It means the upgrade landed on the renewal boundary,
   * where the new plan's full price is about to be billed anyway.
   */
  const amountK =
    total <= 0 || remaining <= 0
      ? 0
      : Math.floor((differenceK * Math.min(remaining, total)) / total);

  return { kind, amountK, effectiveFrom: 'now', renewsAt: input.renewsAt };
}

/**
 * The same day next month, or the last day of it.
 *
 * 31 January renews on 28 February rather than drifting into March, and the
 * following month returns to 31. Anchoring on the original day is what stops
 * a merchant's renewal date walking backwards through the year.
 */
export function addMonth(from: Date, anchorDay?: number): Date {
  const lagos = new Date(from.getTime() + 3_600_000);
  const day = anchorDay ?? lagos.getUTCDate();
  const year = lagos.getUTCFullYear();
  const month = lagos.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const next = new Date(
    Date.UTC(year, month, Math.min(day, lastDay), lagos.getUTCHours(), lagos.getUTCMinutes()),
  );
  return new Date(next.getTime() - 3_600_000);
}

/** Whole days from `a` to `b`, never negative. */
function wholeDaysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / DAY_MS));
}

/* ── a payment that did not go through ────────────────────────────────────── */

/** ADR 0024: seven days, with reminders on day 1 and day 5. */
export const GRACE_DAYS = 7;
export const GRACE_REMINDER_DAYS = [1, 5] as const;

export type BillingState =
  | { state: 'active'; renewsAt: Date }
  /** Paid features still work; the merchant is being reminded. */
  | { state: 'grace'; endsAt: Date; daysLeft: number; remindToday: boolean }
  /** Paid features stop. Nothing is deleted and the books stay readable. */
  | { state: 'expired'; since: Date };

/**
 * Where a merchant stands after a renewal payment failed.
 *
 * Access does not stop on the day the card declines. A Nigerian merchant
 * whose card fails on a Sunday should not lose the ability to invoice on
 * Monday, and the cost of seven more days of service is far below the cost of
 * a merchant who leaves because the product punished them for a bank's
 * problem.
 *
 * `remindToday` is true on exactly the reminder days, so the sweep that calls
 * this can send one message rather than deciding for itself when to send.
 */
export function billingState(input: {
  renewsAt: Date;
  /** Null when the last renewal succeeded. */
  failedAt: Date | null;
  now: Date;
}): BillingState {
  if (!input.failedAt) return { state: 'active', renewsAt: input.renewsAt };

  const endsAt = new Date(input.failedAt.getTime() + GRACE_DAYS * DAY_MS);
  if (input.now >= endsAt) return { state: 'expired', since: endsAt };

  const elapsed = wholeDaysBetween(input.failedAt, input.now);
  return {
    state: 'grace',
    endsAt,
    daysLeft: Math.max(0, GRACE_DAYS - elapsed),
    remindToday: (GRACE_REMINDER_DAYS as readonly number[]).includes(elapsed),
  };
}

/* ── add-on packs ─────────────────────────────────────────────────────────── */

export interface AddOnPack {
  readonly id: string;
  readonly label: string;
  readonly unit: UsageUnit;
  /** How much of the unit the pack adds. Voice is seconds, as the meter is. */
  readonly quantity: number;
  readonly priceK: number;
}

/**
 * The consumable packs, priced in `docs/pricing-model.md`.
 *
 * One-off and no rollover (ADR 0024). Bought for the month they are bought
 * in, and gone at the next reset: rollover is an accrual, and an accrual in
 * the meter is a number two months can disagree about.
 *
 * The extra accountant or delegate seat is deliberately NOT here. It is a
 * standing capability rather than a quantity consumed, so it is a recurring
 * line on the subscription and not a pack.
 */
export const ADD_ON_PACKS: readonly AddOnPack[] = [
  {
    id: 'messages_100',
    label: '100 extra WhatsApp messages',
    unit: 'messages',
    quantity: 100,
    priceK: 250_000,
  },
  {
    id: 'voice_30min',
    label: '30 extra voice minutes',
    unit: 'voice_seconds',
    quantity: 1_800,
    priceK: 150_000,
  },
  {
    id: 'documents_50',
    label: '50 extra document generations',
    unit: 'documents',
    quantity: 50,
    priceK: 200_000,
  },
  {
    id: 'orders_50',
    label: '50 extra Integrate orders',
    unit: 'orders',
    quantity: 50,
    priceK: 500_000,
  },
];

/** ₦1,500 a month, recurring, and not a pack. */
export const EXTRA_SEAT_PRICE_K = 150_000;

export function addOnPack(id: string): AddOnPack | null {
  return ADD_ON_PACKS.find((pack) => pack.id === id) ?? null;
}

/**
 * Which packs a plan may buy.
 *
 * Nothing at all without a paid plan, which is the case that matters most.
 * An EXPIRED merchant sold a message pack would be paying ₦2,500 for capacity
 * against a plan that grants zero of everything: they would have bought
 * nothing usable. A merchant on trial should convert rather than buy overage,
 * and a pack is overage on a plan by definition.
 *
 * ADR 0024 does not cover this case. Requiring a paid plan is the reading that
 * cannot take money for something a merchant cannot use.
 *
 * Beyond that, a Chat merchant cannot buy Integrate orders, because Chat does
 * not capture catalogue orders at all. Voice is the same in reverse for
 * Integrate, which has no voice bookkeeping.
 */
export function packsFor(plan: string): AddOnPack[] {
  if ((PLAN_PRICES_K[plan as PlanId] ?? 0) === 0) return [];
  return ADD_ON_PACKS.filter((pack) => {
    if (pack.unit === 'orders') return plan === 'integrate' || plan === 'complete';
    if (pack.unit === 'voice_seconds') return plan === 'chat' || plan === 'complete';
    return true;
  });
}

/* ── references ───────────────────────────────────────────────────────────── */

/**
 * `RKD-SUB-20260819-A83F92` and `RKD-PACK-…`, minted before anything reaches a
 * provider.
 *
 * The same construction as a payment reference and for the same reasons: the
 * date segment narrows a human search weeks later, the alphabet is safe to
 * read over the phone, and randomness is injected because `@rekoda/core` has
 * none of its own.
 */
export function subscriptionReference(at: Date, random: RandomBytes): string {
  return mintReference('SUB', at, random);
}

export function addOnReference(at: Date, random: RandomBytes): string {
  return mintReference('PACK', at, random);
}

/**
 * What one of ours looks like coming back from a provider.
 *
 * Separate from `PAYMENT_REFERENCE_PATTERN` and deliberately so: a merchant's
 * customer paying an invoice and a merchant paying US arrive on the same
 * webhook and must not be confused. One books into their ledger; the other
 * must never touch it.
 */
export const SUBSCRIPTION_REFERENCE_PATTERN = /^RKD-(SUB|PACK)-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/;
