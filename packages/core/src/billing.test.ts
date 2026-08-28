import { describe, expect, it } from 'vitest';
import {
  ADD_ON_PACKS,
  addMonth,
  addOnPack,
  billingState,
  EXTRA_SEAT_PRICE_K,
  packsFor,
  planChangeCharge,
  planChangeKind,
} from './billing.js';

const at = (iso: string) => new Date(iso);

describe('classifying a plan change', () => {
  it('reads the ladder off the prices, not a hand-written table', () => {
    expect(planChangeKind('chat', 'complete')).toBe('upgrade');
    expect(planChangeKind('complete', 'chat')).toBe('downgrade');
    expect(planChangeKind('chat', 'integrate')).toBe('upgrade');
    expect(planChangeKind('integrate', 'chat')).toBe('downgrade');
    expect(planChangeKind('chat', 'chat')).toBe('same');
  });

  it('treats trial and expired as a first purchase, not an upgrade', () => {
    /* There is no cycle to prorate against, so these cannot be handled by the
     * upgrade path however much they look like one. */
    expect(planChangeKind('trial', 'chat')).toBe('first_purchase');
    expect(planChangeKind('expired', 'complete')).toBe('first_purchase');
  });

  it('does not call a move between two free states a purchase', () => {
    expect(planChangeKind('trial', 'expired')).toBe('same');
  });
});

describe('what an upgrade costs', () => {
  /** Angelo's worked example, from ADR 0024. */
  it('charges the prorated difference for the days that remain', () => {
    const charge = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-12T00:00:00Z'),
    });
    expect(charge.kind).toBe('upgrade');
    /* ₦20,000 difference, 19 of 30 days left: ₦12,666.67 */
    expect(charge.amountK).toBe(1_266_666);
    expect(charge.effectiveFrom).toBe('now');
  });

  it('leaves the renewal date alone, so there is one date to remember', () => {
    const renewsAt = at('2026-08-31T00:00:00Z');
    const charge = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt,
      now: at('2026-08-12T00:00:00Z'),
    });
    expect(charge.renewsAt).toEqual(renewsAt);
  });

  it('rounds down, so the formula can only ever undercharge', () => {
    const charge = planChangeCharge({
      from: 'chat',
      to: 'integrate',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-08T00:00:00Z'),
    });
    /* ₦10,000 × 23/30 = ₦7,666.666..., floored. */
    expect(charge.amountK).toBe(766_666);
  });

  it('charges almost the full difference on day one', () => {
    const charge = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-01T00:00:00Z'),
    });
    expect(charge.amountK).toBe(2_000_000);
  });

  it('charges nothing when the upgrade lands on the renewal boundary', () => {
    /* The new plan's full price is about to be billed anyway. Charging a
     * prorated slice of zero days on top would be billing twice. */
    const charge = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-31T00:00:00Z'),
    });
    expect(charge.amountK).toBe(0);
  });

  it('does not divide by zero on a cycle with no length', () => {
    const charge = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: at('2026-08-31T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-31T00:00:00Z'),
    });
    expect(charge.amountK).toBe(0);
    expect(Number.isFinite(charge.amountK)).toBe(true);
  });

  it('never charges more than the difference, even with a clock skewed early', () => {
    const charge = planChangeCharge({
      from: 'chat',
      to: 'complete',
      cycleStart: at('2026-08-10T00:00:00Z'),
      renewsAt: at('2026-09-10T00:00:00Z'),
      now: at('2026-08-01T00:00:00Z'),
    });
    expect(charge.amountK).toBeLessThanOrEqual(2_000_000);
  });
});

describe('what a downgrade costs', () => {
  it('is nothing, and waits for the next renewal', () => {
    const charge = planChangeCharge({
      from: 'complete',
      to: 'chat',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-12T00:00:00Z'),
    });
    expect(charge.kind).toBe('downgrade');
    expect(charge.amountK).toBe(0);
    /* No credit, no balance to carry. They keep what they paid for. */
    expect(charge.effectiveFrom).toBe('next_renewal');
  });
});

describe('a first purchase', () => {
  it('charges the full price and starts a cycle now', () => {
    const charge = planChangeCharge({
      from: 'trial',
      to: 'chat',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-12T00:00:00Z'),
    });
    expect(charge.kind).toBe('first_purchase');
    expect(charge.amountK).toBe(990_000);
    expect(charge.effectiveFrom).toBe('now');
    /* A fresh month from today, not the leftover of a trial. */
    expect(charge.renewsAt.toISOString().slice(0, 10)).toBe('2026-09-12');
  });

  it('charges an expired merchant the same as a new one', () => {
    const charge = planChangeCharge({
      from: 'expired',
      to: 'complete',
      cycleStart: at('2026-08-01T00:00:00Z'),
      renewsAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-12T00:00:00Z'),
    });
    expect(charge.amountK).toBe(2_990_000);
  });
});

describe('addMonth', () => {
  it('keeps the day of the month', () => {
    expect(addMonth(at('2026-08-12T09:00:00Z')).toISOString().slice(0, 10)).toBe('2026-09-12');
  });

  it('clamps to the last day rather than spilling into the month after', () => {
    /* 31 January has no counterpart in February. Spilling to 3 March would
     * move a merchant's renewal date permanently. */
    expect(addMonth(at('2026-01-31T09:00:00Z')).toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('returns to the anchor day once the short month is past', () => {
    /* Without an anchor, 31 January would become 28 February and then 28
     * March, walking the date backwards a few days every year. */
    const anchored = addMonth(at('2026-02-28T09:00:00Z'), 31);
    expect(anchored.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('handles a leap February', () => {
    expect(addMonth(at('2028-01-31T09:00:00Z')).toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('crosses a year end', () => {
    expect(addMonth(at('2026-12-15T09:00:00Z')).toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});

describe('after a failed renewal', () => {
  const renewsAt = at('2026-08-31T00:00:00Z');

  it('is simply active while nothing has failed', () => {
    const state = billingState({ renewsAt, failedAt: null, now: at('2026-08-12T00:00:00Z') });
    expect(state.state).toBe('active');
  });

  it('keeps paid features working the day the card declines', () => {
    const state = billingState({
      renewsAt,
      failedAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-08-31T06:00:00Z'),
    });
    expect(state.state).toBe('grace');
    if (state.state !== 'grace') return;
    expect(state.daysLeft).toBe(7);
  });

  it('counts the days down', () => {
    const state = billingState({
      renewsAt,
      failedAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-09-03T00:00:00Z'),
    });
    expect(state.state).toBe('grace');
    if (state.state !== 'grace') return;
    expect(state.daysLeft).toBe(4);
  });

  it('names the reminder day reached, so an outage delays a warning instead of cancelling it', () => {
    const due = (day: number) => {
      const state = billingState({
        renewsAt,
        failedAt: at('2026-08-31T00:00:00Z'),
        now: new Date(at('2026-08-31T00:00:00Z').getTime() + day * 86_400_000),
      });
      return state.state === 'grace' ? state.reminderDue : 'expired';
    };
    /* Day 0 owes nothing; days 1-4 all answer "day one", which is what lets
     * a sweep that slept through day one still send that warning once; day
     * 5 onward answers "day five". The claim, keyed on the day named here,
     * is what keeps a late answer from becoming a second message. */
    expect([0, 1, 2, 3, 4, 5, 6].map(due)).toEqual([null, 1, 1, 1, 1, 5, 5]);
  });

  it('expires on day seven, not before', () => {
    const justBefore = billingState({
      renewsAt,
      failedAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-09-06T23:59:00Z'),
    });
    expect(justBefore.state).toBe('grace');

    const onTheDay = billingState({
      renewsAt,
      failedAt: at('2026-08-31T00:00:00Z'),
      now: at('2026-09-07T00:00:00Z'),
    });
    expect(onTheDay.state).toBe('expired');
  });

  it('stays expired afterwards rather than wrapping round', () => {
    const state = billingState({
      renewsAt,
      failedAt: at('2026-08-31T00:00:00Z'),
      now: at('2027-03-01T00:00:00Z'),
    });
    expect(state.state).toBe('expired');
  });
});

describe('add-on packs', () => {
  it('are priced as the pricing model says', () => {
    expect(addOnPack('messages_100')).toMatchObject({ quantity: 100, priceK: 250_000 });
    expect(addOnPack('voice_30min')).toMatchObject({ quantity: 1_800, priceK: 150_000 });
    expect(addOnPack('documents_50')).toMatchObject({ quantity: 50, priceK: 200_000 });
    expect(addOnPack('orders_50')).toMatchObject({ quantity: 50, priceK: 500_000 });
  });

  it('count voice in seconds, because that is what the meter counts', () => {
    /* 30 minutes. A pack measured in minutes against a meter measured in
     * seconds is a sixtyfold error waiting for somebody to make it. */
    expect(addOnPack('voice_30min')?.unit).toBe('VOICE_MINUTES');
    expect(addOnPack('voice_30min')?.quantity).toBe(30 * 60);
  });

  it('do not include the extra seat, which is recurring rather than consumed', () => {
    expect(ADD_ON_PACKS.some((p) => p.id.includes('seat'))).toBe(false);
    expect(EXTRA_SEAT_PRICE_K).toBe(150_000);
  });

  it('is nothing for an id nobody sells', () => {
    expect(addOnPack('messages_1000000')).toBeNull();
  });

  it('every pack names a real usage unit', () => {
    for (const pack of ADD_ON_PACKS) {
      expect(['AI_ACTIONS', 'VOICE_MINUTES', 'DOCUMENT_GENERATION', 'CATALOGUE_ORDERS']).toContain(
        pack.unit,
      );
      expect(pack.quantity).toBeGreaterThan(0);
      expect(pack.priceK).toBeGreaterThan(0);
    }
  });
});

describe('which packs a plan may buy', () => {
  it('sells nothing at all without a paid plan', () => {
    /* An expired merchant buying a message pack would pay ₦2,500 for capacity
     * against a plan that grants zero of everything. A merchant on trial
     * should convert rather than buy overage on a plan they do not have. */
    expect(packsFor('trial')).toEqual([]);
    expect(packsFor('expired')).toEqual([]);
    expect(packsFor('nonsense')).toEqual([]);
  });

  it('does not sell Integrate orders to a Chat merchant', () => {
    /* Chat captures no catalogue orders, so the capacity would be for
     * something they cannot do. */
    expect(packsFor('chat').map((p) => p.id)).not.toContain('orders_50');
  });

  it('sells voice minutes to every paid plan, because every paid plan now carries voice', () => {
    /* The old rule refused Integrate the voice pack because Integrate had no
     * voice allowance. The ladder fix gave it one, and an allowance a
     * merchant can exhaust must come with the overage path. */
    for (const plan of ['chat', 'integrate', 'complete']) {
      expect(packsFor(plan).map((p) => p.id)).toContain('voice_30min');
    }
  });

  it('sells everything to Complete, which does everything', () => {
    expect(packsFor('complete')).toHaveLength(ADD_ON_PACKS.length);
  });

  it('always sells messages and documents, which every plan uses', () => {
    for (const plan of ['chat', 'integrate', 'complete']) {
      const ids = packsFor(plan).map((p) => p.id);
      expect(ids).toContain('messages_100');
      expect(ids).toContain('documents_50');
    }
  });
});

describe('catalogue prices through planChangeCharge (BL2)', () => {
  const cycle = {
    cycleStart: at('2026-08-01T00:00:00Z'),
    renewsAt: at('2026-08-31T00:00:00Z'),
    now: at('2026-08-16T00:00:00Z'),
  };

  it('prices the difference from the prices it is handed, not the constants', () => {
    /* A grandfathered merchant pays 9,900 for chat while the catalogue
     * sells integrate at a repriced 25,000: the proration must use BOTH
     * figures as handed, or the charge mixes two price lists. */
    const charge = planChangeCharge({
      from: 'chat',
      to: 'integrate',
      ...cycle,
      pricesK: { from: 990_000, to: 2_500_000 },
    });
    expect(charge.kind).toBe('upgrade');
    /* 15 of 30 days remain on a 1,510,000 difference. */
    expect(charge.amountK).toBe(Math.floor((1_510_000 * 15) / 30));
  });

  it('classifies from the same prices too: data can invert the constant ladder', () => {
    /* If the catalogue ever prices integrate BELOW the merchant's pinned
     * chat price, the move is a downgrade - free, at renewal - whatever
     * the constant table would have said. */
    const charge = planChangeCharge({
      from: 'chat',
      to: 'integrate',
      ...cycle,
      pricesK: { from: 990_000, to: 500_000 },
    });
    expect(charge.kind).toBe('downgrade');
    expect(charge.amountK).toBe(0);
  });

  it('two different plans priced identically move as a downgrade, never as "same"', () => {
    const charge = planChangeCharge({
      from: 'chat',
      to: 'integrate',
      ...cycle,
      pricesK: { from: 990_000, to: 990_000 },
    });
    expect(charge.kind).toBe('downgrade');
    expect(charge.effectiveFrom).toBe('next_renewal');
  });

  it('absent prices fall back to the constant table unchanged', () => {
    const withData = planChangeCharge({
      from: 'chat',
      to: 'complete',
      ...cycle,
      pricesK: { from: 990_000, to: 2_990_000 },
    });
    const withConstants = planChangeCharge({ from: 'chat', to: 'complete', ...cycle });
    expect(withData).toEqual(withConstants);
  });
});
