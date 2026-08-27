/**
 * The recognition engine (spec §12) — pure, event-driven, and never told
 * which case it is in. The same arithmetic produces all five golden cases.
 *
 * §12.2's discipline, kept literally:
 *   - No hardcoded accounting shapes: the engine answers with role-keyed
 *     lines derived from event + ledger state, and the ledger is the
 *     authoritative balance — the caller reads per-order balances FROM the
 *     ledger and hands them in; nothing here keeps a copy.
 *   - The superseded formula (contractLiability = received + raised −
 *     earned) is not implemented anywhere: collecting a receivable moves
 *     an asset, it does not create a second obligation, and the payment
 *     rule below leaves contract liability untouched.
 *   - The command is atomic. A refusal posts NOTHING and loses nothing:
 *     re-running the same events against a later engine clears the backlog
 *     deterministically. Refusing is not discarding.
 */
import type { SystemRole } from './chart.js';

export const RECEIVABLE_RECOGNITION_POLICIES = [
  /** The invoice itself creates the right. */
  'ON_ISSUE_UNCONDITIONAL',
  /** The right arises when the obligation is satisfied. */
  'ON_FULFILMENT',
  /** No receivable is ever raised (cash and carry). */
  'NONE',
] as const;
export type ReceivableRecognitionPolicy = (typeof RECEIVABLE_RECOGNITION_POLICIES)[number];

export const REVENUE_RECOGNITION_POLICIES = ['AT_POINT_IN_TIME_ON_FULFILMENT'] as const;
export type RevenueRecognitionPolicy = (typeof REVENUE_RECOGNITION_POLICIES)[number];

/** §12.2: reviewReason is an enum, never prose, and never one bucket. */
export const REVIEW_REASONS = ['UNSUPPORTED_CONTRACT_ASSET'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Where collected money lands. A role, resolved by the caller's chart. */
export type MoneyRole = Extract<SystemRole, 'BANK' | 'CASH' | 'PAYMENT_PROVIDER_CLEARING'>;

/** The roles a recognition posting may touch. */
export type RecognitionRole =
  | MoneyRole
  | Extract<
      SystemRole,
      'ACCOUNTS_RECEIVABLE' | 'CONTRACT_LIABILITY' | 'SALES_REVENUE' | 'COGS' | 'INVENTORY_ASSET'
    >;

export interface RecognitionLine {
  role: RecognitionRole;
  debitMinor: number;
  creditMinor: number;
}

/** What the engine reads per order, AT POSTING TIME, from the ledger. */
export interface OrderLedgerState {
  /** The CONTRACT_LIABILITY balance carried on this order. */
  contractLiabilityMinor: number;
  /** The ACCOUNTS_RECEIVABLE balance carried on this order. */
  receivableMinor: number;
  /** The sum of this order's RevenueRecognitionEvents. */
  revenueRecognisedToDateMinor: number;
}

export type RecognitionEvent =
  /** An unconditional receivable raised before performance (an invoice,
   * under a policy where issuing creates the right). */
  | { kind: 'RECEIVABLE_RAISED'; amountMinor: number }
  /** Money arrived. Against the receivable first; any excess is an
   * advance and becomes contract liability. */
  | { kind: 'PAYMENT_COLLECTED'; amountMinor: number; moneyRole: MoneyRole }
  /** Performance. `collectedNowMinor` is money arriving IN THE SAME
   * transaction (cash and carry): §12.4(e) — contract liability is zero,
   * release is zero, and the delta posts against the cash side directly. */
  | {
      kind: 'FULFILMENT';
      earnedToDateMinor: number;
      costMinor?: number;
      collectedNowMinor?: number;
      moneyRole?: MoneyRole;
    };

export type RecognitionOutcome =
  | { outcome: 'post'; lines: RecognitionLine[]; revenueDeltaMinor: number }
  | { outcome: 'nothing_to_post' }
  /** §12.2: POST NOTHING, keep everything — the refusal is replayable. */
  | {
      outcome: 'requires_review';
      reviewReason: ReviewReason;
      context: {
        recogniseDeltaMinor: number;
        contractLiabilityMinor: number;
        receivableMinor: number;
        collectedNowMinor: number;
      };
    };

/** A violation is a defect in the engine, not a number to be recomputed. */
export class RecognitionInvariantViolation extends Error {}

const line = (role: RecognitionRole, debitMinor: number, creditMinor: number): RecognitionLine => ({
  role,
  debitMinor,
  creditMinor,
});

function assertMinor(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecognitionInvariantViolation(`${what} must be a non-negative integer, got ${value}`);
  }
}

/**
 * §12.2's event rules, verbatim. One function, all five cases.
 */
export function recognise(
  policy: ReceivableRecognitionPolicy,
  state: OrderLedgerState,
  event: RecognitionEvent,
): RecognitionOutcome {
  assertMinor(state.contractLiabilityMinor, 'contract liability');
  assertMinor(state.receivableMinor, 'receivable');
  assertMinor(state.revenueRecognisedToDateMinor, 'revenue recognised to date');

  switch (event.kind) {
    case 'RECEIVABLE_RAISED': {
      assertMinor(event.amountMinor, 'receivable amount');
      /* Billing alone does not establish a right (IFRS for SMEs): only the
       * ON_ISSUE_UNCONDITIONAL policy lets an invoice post, and what it
       * posts is an obligation to perform, not revenue. */
      if (policy !== 'ON_ISSUE_UNCONDITIONAL' || event.amountMinor === 0) {
        return { outcome: 'nothing_to_post' };
      }
      return {
        outcome: 'post',
        revenueDeltaMinor: 0,
        lines: [
          line('ACCOUNTS_RECEIVABLE', event.amountMinor, 0),
          line('CONTRACT_LIABILITY', 0, event.amountMinor),
        ],
      };
    }

    case 'PAYMENT_COLLECTED': {
      assertMinor(event.amountMinor, 'payment amount');
      if (event.amountMinor === 0) return { outcome: 'nothing_to_post' };
      /* Against the receivable first. Collecting a receivable moves an
       * asset; it does not create a second obligation — contract liability
       * is UNCHANGED for that portion (the rule the old formula broke).
       * Only the excess, money for which no right was ever raised, is an
       * advance and becomes contract liability. */
      const toReceivable = Math.min(event.amountMinor, state.receivableMinor);
      const advance = event.amountMinor - toReceivable;
      const lines: RecognitionLine[] = [line(event.moneyRole, event.amountMinor, 0)];
      if (toReceivable > 0) lines.push(line('ACCOUNTS_RECEIVABLE', 0, toReceivable));
      if (advance > 0) lines.push(line('CONTRACT_LIABILITY', 0, advance));
      return { outcome: 'post', revenueDeltaMinor: 0, lines };
    }

    case 'FULFILMENT': {
      assertMinor(event.earnedToDateMinor, 'earned to date');
      const collectedNow = event.collectedNowMinor ?? 0;
      assertMinor(collectedNow, 'collected now');
      if (collectedNow > 0 && !event.moneyRole) {
        throw new RecognitionInvariantViolation('collectedNowMinor needs a moneyRole');
      }

      const delta = event.earnedToDateMinor - state.revenueRecognisedToDateMinor;
      if (delta < 0) {
        /* revenueRecognisedToDate ≤ earnedToDate is an engine invariant. */
        throw new RecognitionInvariantViolation(
          `recognised ${state.revenueRecognisedToDateMinor} exceeds earned ${event.earnedToDateMinor}`,
        );
      }
      if (delta === 0 && collectedNow === 0) return { outcome: 'nothing_to_post' };

      const release = Math.min(delta, state.contractLiabilityMinor);
      const fromMoney = Math.min(delta - release, collectedNow);
      const remaining = delta - release - fromMoney;

      /* Earned, but no unconditional right yet: under IFRS 15 that balance
       * is a contract asset, and V1 does not model one — and MUST NOT
       * silently post it as a receivable, which overstates collectability.
       * Only the ON_FULFILMENT policy makes performance itself create the
       * right. REFUSE ATOMICALLY: post nothing, keep everything. */
      if (remaining > 0 && policy !== 'ON_FULFILMENT') {
        return {
          outcome: 'requires_review',
          reviewReason: 'UNSUPPORTED_CONTRACT_ASSET',
          context: {
            recogniseDeltaMinor: delta,
            contractLiabilityMinor: state.contractLiabilityMinor,
            receivableMinor: state.receivableMinor,
            collectedNowMinor: collectedNow,
          },
        };
      }

      const lines: RecognitionLine[] = [];
      if (release > 0) lines.push(line('CONTRACT_LIABILITY', release, 0));
      if (fromMoney > 0) lines.push(line(event.moneyRole!, fromMoney, 0));
      if (remaining > 0) lines.push(line('ACCOUNTS_RECEIVABLE', remaining, 0));
      if (delta > 0) lines.push(line('SALES_REVENUE', 0, delta));
      /* Money collected now beyond what fulfilment earns settles the
       * receivable or becomes an advance, same as any payment. */
      const excessCollected = collectedNow - fromMoney;
      if (excessCollected > 0) {
        lines.push(line(event.moneyRole!, excessCollected, 0));
        const toReceivable = Math.min(excessCollected, state.receivableMinor);
        if (toReceivable > 0) lines.push(line('ACCOUNTS_RECEIVABLE', 0, toReceivable));
        const advance = excessCollected - toReceivable;
        if (advance > 0) lines.push(line('CONTRACT_LIABILITY', 0, advance));
      }
      const costMinor = event.costMinor ?? 0;
      assertMinor(costMinor, 'cost');
      if (costMinor > 0 && delta > 0) {
        lines.push(line('COGS', costMinor, 0));
        lines.push(line('INVENTORY_ASSET', 0, costMinor));
      }
      if (lines.length === 0) return { outcome: 'nothing_to_post' };
      return { outcome: 'post', revenueDeltaMinor: delta, lines };
    }
  }
}

/**
 * §12.2's post-posting invariants, stated as checks against the ledger,
 * not as definitions of it.
 */
export function assertRecognitionInvariants(input: {
  earnedToDateMinor: number;
  revenueRecognisedToDateMinor: number;
  contractLiabilityMinor: number;
  receivableMinor: number;
}): void {
  if (input.contractLiabilityMinor < 0) {
    throw new RecognitionInvariantViolation(
      `contract liability went negative: ${input.contractLiabilityMinor}`,
    );
  }
  if (input.receivableMinor < 0) {
    throw new RecognitionInvariantViolation(`receivable went negative: ${input.receivableMinor}`);
  }
  if (input.revenueRecognisedToDateMinor > input.earnedToDateMinor) {
    throw new RecognitionInvariantViolation(
      `recognised ${input.revenueRecognisedToDateMinor} exceeds earned ${input.earnedToDateMinor}`,
    );
  }
}
