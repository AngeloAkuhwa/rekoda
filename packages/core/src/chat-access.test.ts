/**
 * The G-65 matrix, asserted intent by intent.
 *
 * Deterministic may skip the model; it may not skip the product. Each row is
 * a decision somebody will eventually be tempted to "simplify" into one guard
 * in front of every command, which would lock a lapsed merchant out of STOP
 * and erasure, or into no guard at all, which would sell Chat for free.
 */
import { describe, expect, it } from 'vitest';
import {
  DETERMINISTIC_ACCESS,
  chatDraftAccess,
  deterministicAccess,
  needsChatStanding,
  resumedReadAccess,
  type ChatStanding,
} from './chat-access.js';
import { entitlementsForPlan } from './entitlements.js';
import { routeMessage, type DeterministicIntent } from './router.js';

const standing = (plan: string): ChatStanding => ({
  plan,
  holdsChat: entitlementsForPlan(plan).includes('REKODA_CHAT'),
});

const PLANS = ['trial', 'chat', 'complete', 'integrate', 'expired'] as const;

/** The intent kind a phrase routes to, or a failure that names the phrase. */
function kindOf(phrase: string): DeterministicIntent['kind'] {
  const route = routeMessage(phrase);
  if (route.route !== 'deterministic') throw new Error(`"${phrase}" does not route`);
  return route.intent.kind;
}

describe('the deterministic entitlement matrix (G-65)', () => {
  const UNIVERSAL = [
    'greeting',
    'help',
    'number',
    'stop',
    'start',
    'delete_my_data',
    'dashboard',
    'upgrade',
  ] as const;
  const KEPT_ON_LAPSE = ['debtors', 'records', 'stock', 'payment_details', 'remind'] as const;

  it('classifies every intent the router can produce, and nothing else', () => {
    expect(Object.keys(DETERMINISTIC_ACCESS).sort()).toEqual(
      [...UNIVERSAL, ...KEPT_ON_LAPSE, 'resend', 'affirm', 'unsure', 'deny', 'cancel'].sort(),
    );
  });

  it.each(PLANS)('lets consent, erasure, the dashboard and upgrade through on %s', (plan) => {
    for (const kind of UNIVERSAL) {
      expect(deterministicAccess(kind, standing(plan)), kind).toBe('allow');
      expect(needsChatStanding(kind), kind).toBe(false);
    }
  });

  it.each(PLANS)('never refuses yes, no or cancel by their words on %s', (plan) => {
    for (const kind of ['affirm', 'unsure', 'deny', 'cancel'] as const) {
      expect(deterministicAccess(kind, standing(plan)), kind).toBe('allow');
    }
  });

  it.each(['trial', 'chat', 'complete'])('runs every Chat command on %s', (plan) => {
    for (const kind of [...KEPT_ON_LAPSE, 'resend'] as const) {
      expect(deterministicAccess(kind, standing(plan)), kind).toBe('allow');
    }
  });

  it('refuses every Chat command to an Integrate-only plan', () => {
    for (const kind of [...KEPT_ON_LAPSE, 'resend'] as const) {
      expect(deterministicAccess(kind, standing('integrate')), kind).toBe('chat_not_in_plan');
      expect(needsChatStanding(kind), kind).toBe(true);
    }
  });

  it('keeps the reads a lapsed plan is promised, and refuses it a new document send', () => {
    for (const kind of KEPT_ON_LAPSE) {
      expect(deterministicAccess(kind, standing('expired')), kind).toBe('allow');
    }
    expect(deterministicAccess('resend', standing('expired'))).toBe('plan_lapsed');
  });

  it('asks the lapsed question first, as the model path does', () => {
    // An explicit REKODA_CHAT grant does not reopen a lapsed plan's sends.
    expect(deterministicAccess('resend', { plan: 'expired', holdsChat: true })).toBe('plan_lapsed');
    expect(chatDraftAccess({ plan: 'expired', holdsChat: true })).toBe('plan_lapsed');
    // And a grant on a live plan is what it says it is.
    expect(deterministicAccess('resend', { plan: 'integrate', holdsChat: true })).toBe('allow');
  });

  it('an unknown plan is refused rather than trusted', () => {
    expect(deterministicAccess('debtors', standing('platinum'))).toBe('chat_not_in_plan');
  });
});

describe('English and Pidgin share one entitlement', () => {
  const SYNONYMS: ReadonlyArray<readonly [string, string]> = [
    ['stock', 'wetin remain'],
    ['what is left', 'what dey left'],
    ['who owes me', 'who dey owe me'],
    ['who owes me', 'who dey owe'],
  ];

  it.each(SYNONYMS)('"%s" and "%s" meet the same boundary', (english, pidgin) => {
    expect(kindOf(english)).toBe(kindOf(pidgin));
    for (const plan of PLANS) {
      expect(deterministicAccess(kindOf(pidgin), standing(plan))).toBe(
        deterministicAccess(kindOf(english), standing(plan)),
      );
    }
    expect(deterministicAccess(kindOf(pidgin), standing('integrate'))).toBe('chat_not_in_plan');
  });

  it('STOP stays open to a plan without Chat', () => {
    expect(deterministicAccess(kindOf('STOP'), standing('integrate'))).toBe('allow');
  });
});

describe('a yes and a resumed read meet the boundary their capability meets', () => {
  it('a yes to a Chat draft needs Chat, and a lapsed plan records nothing', () => {
    expect(chatDraftAccess(standing('chat'))).toBe('allow');
    expect(chatDraftAccess(standing('complete'))).toBe('allow');
    expect(chatDraftAccess(standing('trial'))).toBe('allow');
    expect(chatDraftAccess(standing('integrate'))).toBe('chat_not_in_plan');
    expect(chatDraftAccess(standing('expired'))).toBe('plan_lapsed');
  });

  it('a resumed read is a read: Integrate is refused it, a lapsed plan keeps it', () => {
    expect(resumedReadAccess(standing('chat'))).toBe('allow');
    expect(resumedReadAccess(standing('integrate'))).toBe('chat_not_in_plan');
    expect(resumedReadAccess(standing('expired'))).toBe('allow');
  });
});
