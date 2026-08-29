/**
 * The rule Appendix D.3 exists for: no front door gets a cheaper path.
 *
 * The interesting assertion is not that a refund needs a confirmation. It is
 * that the SAME refund needs the same confirmation whether it arrives from
 * chat, the dashboard, the storefront, a WABA, the public API, an embed or a
 * background sweep, and that the away assistant cannot have it at all. Every
 * ingress is asserted individually and by name, because a policy that is
 * enforced in six places and forgotten in the seventh is not a policy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { INGRESSES, matchesPhrase, phraseFor, replies, type Ingress } from '@rekoda/core';
import { RiskPolicyService } from './risk-policy.service.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
const policy = new RiskPolicyService();

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348160000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** Every front door except the one that may never hold a HIGH_RISK command. */
const ATTENDED: Ingress[] = INGRESSES.filter((i) => i !== 'AWAY_ASSISTANT');

describe('every front door obeys the same tiers', () => {
  it.each(ATTENDED)('refuses an unconfirmed refund from %s', async (ingress) => {
    const businessId = await seedBusiness();
    const decision = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress,
      }),
    );
    expect(decision).toEqual({ outcome: 'confirm_first', tier: 'HIGH_RISK' });
  });

  it.each(ATTENDED)('lets an ordinary sale through from %s', async (ingress) => {
    const businessId = await seedBusiness();
    const decision = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, { businessId, command: 'RecordSale', actor: 'user:ada', ingress }),
    );
    expect(decision).toEqual({ outcome: 'allowed', tier: 'STANDARD' });
  });

  it.each(ATTENDED)('lets a question through from %s, ungated', async (ingress) => {
    const businessId = await seedBusiness();
    const decision = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, { businessId, command: 'Query', actor: 'user:ada', ingress }),
    );
    expect(decision).toEqual({ outcome: 'allowed', tier: 'READ_ONLY' });
  });

  /**
   * The command carries the tier, so an ingress cannot reach a softer answer
   * by claiming a different shape. A refund is a refund from every door.
   */
  it.each(ATTENDED)('cannot be talked down from %s by context', async (ingress) => {
    const businessId = await seedBusiness();
    const decision = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command: 'RefundPayment',
        actor: 'user:ada',
        ingress,
        context: { overriding: false, destructive: false, manual: false, mandatoryRole: false },
      }),
    );
    expect(decision).toEqual({ outcome: 'confirm_first', tier: 'HIGH_RISK' });
  });
});

/**
 * Appendix D.3, the absolute rule. Every entry of D.2 is checked one at a
 * time rather than as a set, so a future edit that quietly drops one from the
 * list fails here by name.
 */
describe('the away assistant', () => {
  const HIGH_RISK: Array<[string, Record<string, boolean>]> = [
    ['RefundPayment', {}],
    ['VoidReceipt', {}],
    ['RevokePaymentVerification', {}],
    ['ReopenAccountingPeriod', {}],
    ['EraseData', {}],
    ['ChangePostingAccountPolicy', {}],
    ['DisconnectPaymentConnection', {}],
    ['ChangePaymentConnectionCredential', {}],
    ['ChangePaymentConnectionProvider', {}],
    ['ConfirmReconciliation', { overriding: true }],
    ['AdjustInventory', { destructive: true }],
    ['DeactivateAccount', { mandatoryRole: true }],
  ];

  it.each(HIGH_RISK)('is refused %s outright', async (command, context) => {
    const businessId = await seedBusiness();
    const decision = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command,
        actor: 'assistant',
        ingress: 'AWAY_ASSISTANT',
        context,
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'away_assistant_forbidden' });
  });

  /**
   * "Including when the merchant has performed that same action manually
   * before. Past manual use is not standing consent for an unattended
   * agent." So the merchant does it by hand first, and the assistant is
   * refused the identical command a moment later.
   */
  it('is refused even after the merchant did the same thing by hand', async () => {
    const businessId = await seedBusiness();
    const opened = await withBusiness(db, businessId, (tx) =>
      policy.ask(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
        consequence: 'Refund ₦20,000 to Ada. The money leaves your account.',
        reason: 'customer returned the wig unworn',
      }),
    );
    const byHand = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
        confirmationId: opened.id,
      }),
    );
    expect(byHand).toEqual({ outcome: 'allowed', tier: 'HIGH_RISK' });

    const byAssistant = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_2',
        actor: 'assistant',
        ingress: 'AWAY_ASSISTANT',
      }),
    );
    expect(byAssistant).toEqual({ outcome: 'refused', reason: 'away_assistant_forbidden' });
  });

  /** Everything below HIGH_RISK it may still do, or it is not an assistant. */
  it('may still record a sale and answer a question', async () => {
    const businessId = await seedBusiness();
    for (const command of ['RecordSale', 'Query']) {
      const decision = await withBusiness(db, businessId, (tx) =>
        policy.authorise(tx, {
          businessId,
          command,
          actor: 'assistant',
          ingress: 'AWAY_ASSISTANT',
        }),
      );
      expect(decision.outcome, command).toBe('allowed');
    }
  });
});

describe('a confirmation, once given', () => {
  const ask = (businessId: string, over: Record<string, unknown> = {}) =>
    withBusiness(db, businessId, (tx) =>
      policy.ask(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
        consequence: 'Refund ₦20,000 to Ada. The money leaves your account.',
        reason: 'customer returned the wig unworn',
        ...over,
      }),
    );

  const use = (businessId: string, id: string, over: Record<string, unknown> = {}) =>
    withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
        confirmationId: id,
        ...over,
      }),
    );

  it('works exactly once', async () => {
    const businessId = await seedBusiness();
    const opened = await ask(businessId);
    expect((await use(businessId, opened.id)).outcome).toBe('allowed');
    expect((await use(businessId, opened.id)).outcome).toBe('confirmation_already_used');
  });

  it('is refused after it runs out, and says which wall it hit', async () => {
    const businessId = await seedBusiness();
    const opened = await ask(businessId);
    const late = await withBusiness(db, businessId, (tx) =>
      policy.authorise(
        tx,
        {
          businessId,
          command: 'RefundPayment',
          subject: 'pay_1',
          actor: 'user:ada',
          ingress: 'DASHBOARD',
          confirmationId: opened.id,
        },
        new Date(Date.now() + (policy.ttlSeconds + 60) * 1_000),
      ),
    );
    expect(late).toEqual({ outcome: 'confirmation_expired' });
  });

  /**
   * The binding is the point. A confirmation for one refund, given by one
   * person at one front door, is authority for exactly that and nothing
   * adjacent.
   */
  it.each([
    ['another payment', { subject: 'pay_2' }],
    ['another person', { actor: 'user:staff' }],
    ['another front door', { ingress: 'PUBLIC_API' as Ingress }],
    ['another command', { command: 'ReopenAccountingPeriod' }],
  ])('is not authority for %s', async (_name, over) => {
    const businessId = await seedBusiness();
    const opened = await ask(businessId);
    const wrong = await use(businessId, opened.id, over);
    expect(wrong.outcome).not.toBe('allowed');
  });

  it('is not authority for another merchant', async () => {
    const mine = await seedBusiness('+2348160000001');
    const theirs = await seedBusiness('+2348160000002');
    const opened = await ask(mine);
    const stolen = await withBusiness(db, theirs, (tx) =>
      policy.authorise(tx, {
        businessId: theirs,
        command: 'RefundPayment',
        subject: 'pay_1',
        actor: 'user:ada',
        ingress: 'DASHBOARD',
        confirmationId: opened.id,
      }),
    );
    expect(stolen).toEqual({ outcome: 'confirmation_invalid' });
  });

  /** A confirmation nobody ever opened is invalid, not a silent allow. */
  it('cannot be invented', async () => {
    const businessId = await seedBusiness();
    const made_up = await use(businessId, '00000000-0000-0000-0000-000000000000');
    expect(made_up).toEqual({ outcome: 'confirmation_invalid' });
  });
});

/**
 * The policy has to describe the code that already exists, not contradict it.
 *
 * Erasure is the one HIGH_RISK command Rekoda already ships, and it was built
 * before this table was written: the chat flow parks the request, asks for an
 * exact phrase and only then erases. If the tier table said anything else,
 * one of the two would be wrong and a merchant's customers are the stake.
 */
describe('the erasure flow that already exists', () => {
  it('is classified the way it is actually built', () => {
    expect(policy.tierFor('EraseData')).toBe('HIGH_RISK');
    expect(phraseFor('EraseData')).toBe('DELETE MY DATA');
  });

  /* The phrase the table demands is the phrase the reply asks for. Two
   * strings that have to match, in different packages, with a merchant's
   * customer list between them. */
  it('demands the phrase the confirmation reply asks for', () => {
    const asked = replies.confirmErasure().text;
    expect(asked).toContain(phraseFor('EraseData'));
    expect(matchesPhrase('EraseData', 'DELETE MY DATA')).toBe(true);
  });

  /* And the away assistant may not do it, phrase or no phrase. */
  it('is refused to the away assistant', async () => {
    const businessId = await seedBusiness();
    const decision = await withBusiness(db, businessId, (tx) =>
      policy.authorise(tx, {
        businessId,
        command: 'EraseData',
        actor: 'assistant',
        ingress: 'AWAY_ASSISTANT',
      }),
    );
    expect(decision).toEqual({ outcome: 'refused', reason: 'away_assistant_forbidden' });
  });
});
