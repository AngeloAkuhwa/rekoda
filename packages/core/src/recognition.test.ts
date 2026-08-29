/**
 * The five golden cases (spec §12.4), with §12.4's own numbers — and the
 * property the section closes on: the engine is never told which case it
 * is in; the same arithmetic produces all five.
 */
import { describe, expect, it } from 'vitest';
import {
  assertRecognitionInvariants,
  recognise,
  RecognitionInvariantViolation,
  type OrderLedgerState,
  type RecognitionLine,
} from './recognition.js';

const state = (
  contractLiabilityMinor = 0,
  receivableMinor = 0,
  revenueRecognisedToDateMinor = 0,
): OrderLedgerState => ({ contractLiabilityMinor, receivableMinor, revenueRecognisedToDateMinor });

function byRole(lines: readonly RecognitionLine[]) {
  const out: Record<string, { d: number; c: number }> = {};
  for (const l of lines) {
    const at = (out[l.role] ??= { d: 0, c: 0 });
    at.d += l.debitMinor;
    at.c += l.creditMinor;
  }
  return out;
}

function balanced(lines: readonly RecognitionLine[]): boolean {
  const d = lines.reduce((n, l) => n + l.debitMinor, 0);
  const c = lines.reduce((n, l) => n + l.creditMinor, 0);
  return d === c && d > 0;
}

describe('the five cases (§12.4)', () => {
  it('(a) unconditional receivable before fulfilment', () => {
    const invoice = recognise('ON_ISSUE_UNCONDITIONAL', state(), {
      kind: 'RECEIVABLE_RAISED',
      amountMinor: 100_000,
    });
    expect(invoice.outcome).toBe('post');
    if (invoice.outcome !== 'post') return;
    expect(byRole(invoice.lines)).toEqual({
      ACCOUNTS_RECEIVABLE: { d: 100_000, c: 0 },
      CONTRACT_LIABILITY: { d: 0, c: 100_000 },
    });

    const payment = recognise('ON_ISSUE_UNCONDITIONAL', state(100_000, 100_000), {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'BANK',
    });
    if (payment.outcome !== 'post') throw new Error('payment should post');
    /* Contract liability UNCHANGED — the rule the superseded formula
     * broke: collecting a receivable moves an asset, it does not create a
     * second obligation. CL stays 100,000, never 200,000. */
    expect(byRole(payment.lines)).toEqual({
      BANK: { d: 100_000, c: 0 },
      ACCOUNTS_RECEIVABLE: { d: 0, c: 100_000 },
    });

    const fulfilment = recognise('ON_ISSUE_UNCONDITIONAL', state(100_000, 0), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
    });
    if (fulfilment.outcome !== 'post') throw new Error('fulfilment should post');
    expect(byRole(fulfilment.lines)).toEqual({
      CONTRACT_LIABILITY: { d: 100_000, c: 0 },
      SALES_REVENUE: { d: 0, c: 100_000 },
      COGS: { d: 60_000, c: 0 },
      INVENTORY_ASSET: { d: 0, c: 60_000 },
    });
  });

  it('(b) advance payment, no receivable', () => {
    const payment = recognise('NONE', state(), {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'PAYMENT_PROVIDER_CLEARING',
    });
    if (payment.outcome !== 'post') throw new Error('payment should post');
    expect(byRole(payment.lines)).toEqual({
      PAYMENT_PROVIDER_CLEARING: { d: 100_000, c: 0 },
      CONTRACT_LIABILITY: { d: 0, c: 100_000 },
    });

    const fulfilment = recognise('NONE', state(100_000), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
    });
    if (fulfilment.outcome !== 'post') throw new Error('fulfilment should post');
    expect(byRole(fulfilment.lines)).toEqual({
      CONTRACT_LIABILITY: { d: 100_000, c: 0 },
      SALES_REVENUE: { d: 0, c: 100_000 },
    });
  });

  it('(c) fulfilment before payment: the conditional invoice posts nothing', () => {
    const invoice = recognise('ON_FULFILMENT', state(), {
      kind: 'RECEIVABLE_RAISED',
      amountMinor: 100_000,
    });
    expect(invoice.outcome).toBe('nothing_to_post');

    const fulfilment = recognise('ON_FULFILMENT', state(), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
    });
    if (fulfilment.outcome !== 'post') throw new Error('fulfilment should post');
    expect(byRole(fulfilment.lines)).toEqual({
      ACCOUNTS_RECEIVABLE: { d: 100_000, c: 0 },
      SALES_REVENUE: { d: 0, c: 100_000 },
      COGS: { d: 60_000, c: 0 },
      INVENTORY_ASSET: { d: 0, c: 60_000 },
    });

    const payment = recognise('ON_FULFILMENT', state(0, 100_000, 100_000), {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 100_000,
      moneyRole: 'BANK',
    });
    if (payment.outcome !== 'post') throw new Error('payment should post');
    expect(byRole(payment.lines)).toEqual({
      BANK: { d: 100_000, c: 0 },
      ACCOUNTS_RECEIVABLE: { d: 0, c: 100_000 },
    });
  });

  it('(d) partial deposit', () => {
    const deposit = recognise('ON_FULFILMENT', state(), {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 30_000,
      moneyRole: 'PAYMENT_PROVIDER_CLEARING',
    });
    if (deposit.outcome !== 'post') throw new Error('deposit should post');
    expect(byRole(deposit.lines)).toEqual({
      PAYMENT_PROVIDER_CLEARING: { d: 30_000, c: 0 },
      CONTRACT_LIABILITY: { d: 0, c: 30_000 },
    });

    const fulfilment = recognise('ON_FULFILMENT', state(30_000), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
    });
    if (fulfilment.outcome !== 'post') throw new Error('fulfilment should post');
    expect(byRole(fulfilment.lines)).toEqual({
      CONTRACT_LIABILITY: { d: 30_000, c: 0 },
      ACCOUNTS_RECEIVABLE: { d: 70_000, c: 0 },
      SALES_REVENUE: { d: 0, c: 100_000 },
      COGS: { d: 60_000, c: 0 },
      INVENTORY_ASSET: { d: 0, c: 60_000 },
    });

    const balance = recognise('ON_FULFILMENT', state(0, 70_000, 100_000), {
      kind: 'PAYMENT_COLLECTED',
      amountMinor: 70_000,
      moneyRole: 'BANK',
    });
    if (balance.outcome !== 'post') throw new Error('balance should post');
    expect(byRole(balance.lines)).toEqual({
      BANK: { d: 70_000, c: 0 },
      ACCOUNTS_RECEIVABLE: { d: 0, c: 70_000 },
    });
  });

  it('(e) immediate cash and carry: one event, no transient contract liability', () => {
    /* Sale, payment and fulfilment in one transaction: contract liability
     * is zero, release is zero, the whole delta posts against the cash
     * side directly. Not a special case — the same arithmetic. */
    const out = recognise('NONE', state(), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
      costMinor: 60_000,
      collectedNowMinor: 100_000,
      moneyRole: 'BANK',
    });
    if (out.outcome !== 'post') throw new Error('cash and carry should post');
    expect(byRole(out.lines)).toEqual({
      BANK: { d: 100_000, c: 0 },
      SALES_REVENUE: { d: 0, c: 100_000 },
      COGS: { d: 60_000, c: 0 },
      INVENTORY_ASSET: { d: 0, c: 60_000 },
    });
  });

  it('every posting in every case balances', () => {
    const outs = [
      recognise('ON_ISSUE_UNCONDITIONAL', state(), { kind: 'RECEIVABLE_RAISED', amountMinor: 5 }),
      recognise('NONE', state(0, 3), {
        kind: 'PAYMENT_COLLECTED',
        amountMinor: 7,
        moneyRole: 'CASH',
      }),
      recognise('ON_FULFILMENT', state(2), {
        kind: 'FULFILMENT',
        earnedToDateMinor: 9,
        costMinor: 4,
      }),
    ];
    for (const out of outs) {
      if (out.outcome === 'post') expect(balanced(out.lines)).toBe(true);
    }
  });
});

describe('earned without a right is refused atomically (§12.2)', () => {
  it('posts NOTHING and names the reason as an enum, keeping the balances it saw', () => {
    /* Earned 100k; deposits cover 30k; the policy says billing creates the
     * right and no bill covers the remainder. Under IFRS 15 the 70k is a
     * contract asset; V1 must not silently post it as a receivable. */
    const out = recognise('ON_ISSUE_UNCONDITIONAL', state(30_000), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
    });
    expect(out).toEqual({
      outcome: 'requires_review',
      reviewReason: 'UNSUPPORTED_CONTRACT_ASSET',
      context: {
        recogniseDeltaMinor: 100_000,
        contractLiabilityMinor: 30_000,
        receivableMinor: 0,
        collectedNowMinor: 0,
      },
    });
  });

  it('the refusal is replayable: the same event posts once the right exists', () => {
    /* The human raised the missing invoice: CL now covers the earned
     * amount, the identical fulfilment event replays and posts. Nothing
     * was posted before, so nothing needs unpicking. */
    const replay = recognise('ON_ISSUE_UNCONDITIONAL', state(100_000), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 100_000,
    });
    expect(replay.outcome).toBe('post');
  });
});

describe('rules and invariants (§12.2, §12.5)', () => {
  it('partial fulfilment recognises only the fulfilled proportion, never more', () => {
    const half = recognise('NONE', state(100_000), {
      kind: 'FULFILMENT',
      earnedToDateMinor: 40_000,
    });
    if (half.outcome !== 'post') throw new Error('should post');
    expect(half.revenueDeltaMinor).toBe(40_000);
    expect(byRole(half.lines).SALES_REVENUE).toEqual({ d: 0, c: 40_000 });
  });

  it('an already-recognised fulfilment has nothing to post: idempotent by delta', () => {
    expect(
      recognise('NONE', state(0, 0, 100_000), { kind: 'FULFILMENT', earnedToDateMinor: 100_000 }),
    ).toEqual({ outcome: 'nothing_to_post' });
  });

  it('recognised beyond earned is a defect, not a number to recompute', () => {
    expect(() =>
      recognise('NONE', state(0, 0, 100_001), { kind: 'FULFILMENT', earnedToDateMinor: 100_000 }),
    ).toThrow(RecognitionInvariantViolation);
    expect(() =>
      assertRecognitionInvariants({
        earnedToDateMinor: 100_000,
        revenueRecognisedToDateMinor: 100_001,
        contractLiabilityMinor: 0,
        receivableMinor: 0,
      }),
    ).toThrow(RecognitionInvariantViolation);
  });

  it('negative ledger balances are a defect wherever they appear', () => {
    expect(() =>
      assertRecognitionInvariants({
        earnedToDateMinor: 0,
        revenueRecognisedToDateMinor: 0,
        contractLiabilityMinor: -1,
        receivableMinor: 0,
      }),
    ).toThrow(RecognitionInvariantViolation);
  });
});
