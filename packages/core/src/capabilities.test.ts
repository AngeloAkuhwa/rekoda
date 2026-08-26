/**
 * The dashboard is shared; the front doors are not.
 *
 * Owner decision, 26 August 2026: an Integrate-only merchant may use the
 * dashboard to see and maintain their books. What Chat sells is the
 * conversational interface, not permission to own records. The matrix below
 * is that decision, and it is asserted plan by plan because "Integrate can
 * still add an expense" is the assertion somebody will eventually break while
 * tidying something else.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_SOURCE,
  capabilitiesFor,
  hasCapability,
  planSwitch,
  refusalFor,
  type Capability,
} from './capabilities.js';
import { entitlementsForPlan } from './entitlements.js';

const forPlan = (plan: string) => capabilitiesFor(plan, entitlementsForPlan(plan));

/** The bookkeeping every paid plan carries, whichever door the merchant uses. */
const SHARED: Capability[] = [
  'DASHBOARD_READ',
  'MANUAL_BOOKKEEPING',
  'REPORTING',
  'PAYMENT_CONNECTIONS',
  'FINANCIAL_ACCOUNT_CONNECTIONS',
  'RECONCILIATION',
];

const CHAT_ONLY: Capability[] = [
  'CONVERSATIONAL_BOOKKEEPING',
  'VOICE_BOOKKEEPING',
  'DOCUMENT_UNDERSTANDING',
  'FINANCIAL_QA',
];

const INTEGRATE_ONLY: Capability[] = [
  'CUSTOMER_COMMERCE',
  'CATALOGUE',
  'WABA_CONNECTION',
  'CUSTOMER_ORDER_AUTOMATION',
  'TEMPLATE_AUTOMATION',
  'AWAY_ASSISTANT',
];

describe('the shared control plane', () => {
  it.each(['chat', 'integrate', 'complete', 'trial'])('gives %s the whole dashboard', (plan) => {
    for (const capability of SHARED) {
      expect(hasCapability(capability, plan, entitlementsForPlan(plan)), capability).toBe(true);
    }
  });

  /**
   * The decision, stated as the assertion it is. A merchant paying ₦19,900
   * for automated commerce can record their electricity bill without buying
   * a second product, and an automated accounting system a merchant cannot
   * correct by hand is one they cannot operate.
   */
  it('lets an Integrate-only merchant keep their own books by hand', () => {
    const integrate = forPlan('integrate');
    expect(integrate).toContain('MANUAL_BOOKKEEPING');
    expect(integrate).toContain('REPORTING');
    expect(integrate).toContain('RECONCILIATION');
  });

  /** And it is not Chat that they got. That is the whole point of the split. */
  it('gives them none of the conversational interface', () => {
    const integrate = forPlan('integrate');
    for (const capability of CHAT_ONLY) {
      expect(integrate, capability).not.toContain(capability);
    }
  });
});

describe('the two front doors', () => {
  it('gives Chat the conversational interface and no customer commerce', () => {
    const chat = forPlan('chat');
    for (const capability of CHAT_ONLY) expect(chat).toContain(capability);
    for (const capability of INTEGRATE_ONLY) expect(chat).not.toContain(capability);
  });

  it('gives Integrate customer commerce and no conversational interface', () => {
    const integrate = forPlan('integrate');
    for (const capability of INTEGRATE_ONLY) expect(integrate).toContain(capability);
    for (const capability of CHAT_ONLY) expect(integrate).not.toContain(capability);
  });

  it('gives Complete both, because Complete is the pair', () => {
    expect(forPlan('complete').sort()).toEqual([...CAPABILITIES].sort());
  });
});

/**
 * Spec §4.5: downgrade never destroys records, and existing statements remain
 * correct and exportable. A merchant whose trial ended still owns their books.
 * A product that locks somebody out of their own accounts to sell them a plan
 * has stopped being a bookkeeper.
 */
describe('a plan that has lapsed', () => {
  it('keeps the merchant able to read what they recorded', () => {
    expect(hasCapability('DASHBOARD_READ', 'expired', [])).toBe(true);
  });

  it('stops new records and every front door', () => {
    for (const capability of CAPABILITIES) {
      if (capability === 'DASHBOARD_READ') continue;
      expect(hasCapability(capability, 'expired', []), capability).toBe(false);
    }
  });
});

/**
 * The design system owes `EntitlementRefusal` three things: what is
 * unavailable, why, and what would change it. A refusal missing the third is
 * a dead end rather than a doorway.
 */
describe('what a merchant is told', () => {
  it('names the capability, the reason and the plans that carry it', () => {
    const refusal = refusalFor('CONVERSATIONAL_BOOKKEEPING', 'integrate');
    expect(refusal.what).toBe('recording by message');
    expect(refusal.why).toContain('Rekoda Chat');
    expect(refusal.availableOn).toEqual(['Rekoda Chat', 'Rekoda Complete']);
  });

  it('never offers the plan they are already on', () => {
    expect(refusalFor('CATALOGUE', 'chat').availableOn).not.toContain('Rekoda Chat');
    expect(refusalFor('CONVERSATIONAL_BOOKKEEPING', 'integrate').availableOn).not.toContain(
      'Rekoda Integrate',
    );
  });

  /* It never says "you did not pay for this". A merchant on Integrate paid,
   * for something else, and being told what they DO have is the difference
   * between a boundary and a punishment. */
  it('reassures rather than accuses', () => {
    for (const capability of [...CHAT_ONLY, ...INTEGRATE_ONLY]) {
      const refusal = refusalFor(capability, 'chat');
      expect(refusal.why, capability).toContain('unchanged');
      expect(refusal.why.toLowerCase(), capability).not.toContain('you did not');
    }
  });

  it('gives a lapsed merchant a different sentence entirely', () => {
    expect(refusalFor('MANUAL_BOOKKEEPING', 'expired').why).toContain('still here');
  });
});

describe('every capability is accounted for', () => {
  it('has a source, and the sources are only the ones that exist', () => {
    for (const capability of CAPABILITIES) {
      expect(['SHARED', 'REKODA_CHAT', 'REKODA_INTEGRATE', 'REKODA_API']).toContain(
        CAPABILITY_SOURCE[capability],
      );
    }
    expect(new Set([...SHARED, ...CHAT_ONLY, ...INTEGRATE_ONLY]).size).toBe(CAPABILITIES.length);
  });
});

/**
 * A plan change is a SWITCH, and both directions are shown.
 *
 * Chat to Integrate is the case that made this necessary: the merchant gains
 * automated commerce and loses the conversational interface, and calling that
 * a downgrade would tell them the wrong thing about a decision they are
 * making deliberately. Nobody should learn what they gave up from a refusal a
 * week later.
 */
describe('moving between plans', () => {
  const move = (from: string, to: string) => planSwitch(from, to, entitlementsForPlan);

  it('shows both directions on a lateral move', () => {
    const change = move('chat', 'integrate');
    expect(change.gained).toContain('CUSTOMER_COMMERCE');
    expect(change.gained).toContain('CATALOGUE');
    expect(change.lost).toContain('CONVERSATIONAL_BOOKKEEPING');
    expect(change.lost).toContain('VOICE_BOOKKEEPING');
    expect(change.removesCapability).toBe(true);
  });

  it('shows the same move the other way round', () => {
    const change = move('integrate', 'chat');
    expect(change.gained).toContain('CONVERSATIONAL_BOOKKEEPING');
    expect(change.lost).toContain('CUSTOMER_COMMERCE');
    expect(change.removesCapability).toBe(true);
  });

  /* Never the shared dashboard. Whatever a merchant switches to, their books
   * and the means to keep them by hand come with them. */
  it.each([
    ['chat', 'integrate'],
    ['integrate', 'chat'],
    ['complete', 'chat'],
    ['complete', 'integrate'],
  ])('never takes the dashboard away moving %s to %s', (from, to) => {
    const change = move(from, to);
    for (const shared of SHARED) {
      expect(change.lost, `${from} to ${to} keeps ${shared}`).not.toContain(shared);
    }
  });

  it('takes nothing away moving up to Complete', () => {
    expect(move('chat', 'complete').removesCapability).toBe(false);
    expect(move('integrate', 'complete').removesCapability).toBe(false);
    expect(move('chat', 'complete').gained).toContain('CUSTOMER_COMMERCE');
  });

  it('needs no review when nothing is lost', () => {
    expect(move('chat', 'chat').removesCapability).toBe(false);
    expect(move('chat', 'chat').gained).toEqual([]);
  });
});
