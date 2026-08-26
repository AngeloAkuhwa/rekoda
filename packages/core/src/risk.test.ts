/**
 * The tier table, against Appendix D.
 *
 * Pinned by name rather than by count, because a command silently dropping to
 * a lower tier and a command disappearing are different accidents and only
 * naming them catches both.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMAND_RISK,
  CONFIRMATION_PHRASE,
  INGRESSES,
  RISK_TIERS,
  awayAssistantMayExecute,
  higherTier,
  matchesPhrase,
  phraseFor,
  riskOf,
  type RiskTier,
} from './risk.js';

/** Appendix D.2, as written. Every one of these is HIGH_RISK or the canon is broken. */
const APPENDIX_D2: Array<[string, Parameters<typeof riskOf>[1]]> = [
  ['RefundPayment', {}],
  ['VoidReceipt', {}],
  ['RevokePaymentVerification', {}],
  ['ConfirmReconciliation', { overriding: true }],
  ['ChangePaymentConnectionCredential', {}],
  ['ChangePaymentConnectionProvider', {}],
  ['ReopenAccountingPeriod', {}],
  ['DeactivateAccount', { mandatoryRole: true }],
  ['EraseData', {}],
  ['ChangePostingAccountPolicy', {}],
  ['AdjustInventory', { destructive: true }],
  ['DisconnectPaymentConnection', {}],
];

describe('the three tiers', () => {
  it('is exactly the canonical set', () => {
    expect([...RISK_TIERS]).toEqual(['READ_ONLY', 'STANDARD', 'HIGH_RISK']);
  });

  it('classifies every one of Appendix D.2 as HIGH_RISK', () => {
    for (const [command, context] of APPENDIX_D2) {
      expect(riskOf(command, context), `${command} is HIGH_RISK`).toBe('HIGH_RISK');
    }
  });

  it('leaves reading ungated', () => {
    for (const command of ['Query', 'ReadReport', 'ReadStatement', 'ListInvoices', 'ReadStock']) {
      expect(riskOf(command), command).toBe('READ_ONLY');
    }
  });

  it('puts the ordinary business of bookkeeping at STANDARD', () => {
    for (const command of ['RecordSale', 'RecordPayment', 'RecordExpense', 'IssueInvoice']) {
      expect(riskOf(command), command).toBe('STANDARD');
    }
  });
});

/**
 * The failure mode of forgetting to classify a command has to be a command
 * that is HARDER to run than it needs to be, never one that is easier. This
 * is the single most important assertion in the file.
 */
describe('a command nobody classified', () => {
  it('is HIGH_RISK, not unclassified and not permitted', () => {
    expect(riskOf('SomethingSomebodyAddedOnAFriday')).toBe('HIGH_RISK');
    expect(riskOf('')).toBe('HIGH_RISK');
    expect(awayAssistantMayExecute('SomethingSomebodyAddedOnAFriday')).toBe(false);
  });
});

/**
 * Four of Appendix D.2's entries are a command in a particular SHAPE rather
 * than a command of their own. The shape can raise the tier and must never
 * lower it: there is no way to hold a refund that makes it cheap.
 */
describe('context raises and never lowers', () => {
  it('escalates the four conditional entries', () => {
    expect(riskOf('ConfirmReconciliation')).toBe('STANDARD');
    expect(riskOf('ConfirmReconciliation', { overriding: true })).toBe('HIGH_RISK');
    expect(riskOf('AdjustInventory')).toBe('STANDARD');
    expect(riskOf('AdjustInventory', { destructive: true })).toBe('HIGH_RISK');
    expect(riskOf('DeactivateAccount')).toBe('STANDARD');
    expect(riskOf('DeactivateAccount', { mandatoryRole: true })).toBe('HIGH_RISK');
    expect(riskOf('PostJournal')).toBe('STANDARD');
    expect(riskOf('PostJournal', { manual: true })).toBe('HIGH_RISK');
  });

  it('never lowers a tier, whatever the context claims', () => {
    const every = {
      overriding: false,
      destructive: false,
      mandatoryRole: false,
      manual: false,
    };
    for (const [command, base] of Object.entries(COMMAND_RISK)) {
      expect(riskOf(command, every), `${command} unchanged`).toBe(base as RiskTier);
      expect(
        higherTier(riskOf(command, { overriding: true, destructive: true }), base as RiskTier),
      ).not.toBe('READ_ONLY' === base ? 'STANDARD' : undefined);
    }
    /* And the escalating flags applied to an unrelated command change nothing. */
    expect(riskOf('RecordSale', { overriding: true, destructive: true, manual: true })).toBe(
      'STANDARD',
    );
    expect(riskOf('Query', { destructive: true, overriding: true })).toBe('READ_ONLY');
  });
});

/**
 * Appendix D.3, the absolute rule: the away assistant may never autonomously
 * execute a HIGH_RISK command, "including when the merchant has performed
 * that same action manually before".
 *
 * The function takes no history parameter, no allowlist and no override,
 * because each of those is the mechanism by which an absolute rule quietly
 * stops being absolute. This test exists to make removing that property
 * loud.
 */
describe('the away assistant', () => {
  it('may execute nothing that is HIGH_RISK', () => {
    for (const [command, context] of APPENDIX_D2) {
      expect(awayAssistantMayExecute(command, context), command).toBe(false);
    }
  });

  it('may execute the tiers below it', () => {
    expect(awayAssistantMayExecute('RecordSale')).toBe(true);
    expect(awayAssistantMayExecute('Query')).toBe(true);
  });

  it('takes no argument that could grant it an exception', () => {
    // Past manual use is not standing consent, so there is nowhere to put it.
    expect(awayAssistantMayExecute.length).toBeLessThanOrEqual(2);
  });
});

describe('the front doors', () => {
  it('names every ingress the rule has to reach', () => {
    expect([...INGRESSES].sort()).toEqual(
      [
        'AUTOMATION',
        'AWAY_ASSISTANT',
        'CHAT',
        'DASHBOARD',
        'EMBED',
        'PUBLIC_API',
        'STOREFRONT',
        'WABA',
      ].sort(),
    );
  });
});

/**
 * Appendix D.2 singles out one command: "EraseData — exact-phrase
 * confirmation, never 'yes'". Erasing a merchant's customers is the one thing
 * on the list nobody can undo, and a yes is a reflex where five typed words
 * are a decision.
 */
describe('the one command that needs a phrase', () => {
  it('demands it of erasure and of nothing else', () => {
    expect(phraseFor('EraseData')).toBe('DELETE MY DATA');
    expect(Object.keys(CONFIRMATION_PHRASE)).toEqual(['EraseData']);
    for (const command of ['RefundPayment', 'ReopenAccountingPeriod', 'RecordSale']) {
      expect(phraseFor(command), command).toBeNull();
    }
  });

  /* The phrase Rekoda asks for, matched the way a merchant would type it. */
  it.each(['DELETE MY DATA', 'delete my data', '  Delete My Data  '])('accepts %s', (typed) => {
    expect(matchesPhrase('EraseData', typed)).toBe(true);
  });

  it.each(['yes', 'y', 'ok', 'delete', 'delete my datas', 'delete my  data'])(
    'refuses %s',
    (typed) => {
      expect(matchesPhrase('EraseData', typed)).toBe(false);
    },
  );

  /* A command with no phrase is never satisfied by one, so a caller cannot
   * substitute a typed string for the confirmation a refund actually needs. */
  it('never lets a phrase stand in for a confirmation', () => {
    expect(matchesPhrase('RefundPayment', 'DELETE MY DATA')).toBe(false);
    expect(matchesPhrase('RefundPayment', 'yes')).toBe(false);
  });
});
