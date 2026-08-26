/**
 * What a merchant can DO, as distinct from what they hold.
 *
 * Entitlements are the frozen three of spec §4.1: `REKODA_CHAT`,
 * `REKODA_INTEGRATE`, `REKODA_API`. Capabilities are the layer above them,
 * and they exist because the product has a third thing that is neither.
 *
 * The dashboard is a SHARED merchant control plane (owner decision, 26 Aug
 * 2026). It is not owned by Chat and it is not a fourth product. Chat and
 * Integrate are two front doors over one BusinessId, one ledger, one
 * inventory and one set of statements; the dashboard is where a merchant sees
 * and maintains that shared truth whichever door they came through.
 *
 * The line is HOW a business event enters Rekoda, never whether a merchant
 * may see or maintain their own books:
 *
 *     clicking "Add expense" in a form   →  MANUAL_BOOKKEEPING, shared
 *     "record 35k fuel" in a message     →  CONVERSATIONAL_BOOKKEEPING, Chat
 *
 * Both post the same command through the same accounting engine. One of them
 * needed a model to understand it and the other did not, and that difference
 * is the entire thing Chat sells.
 *
 * Capabilities are checked instead of pages, because a page is a URL and a
 * URL is a coincidence of routing. `if (plan === 'integrate') hideExpenses()`
 * is the shape that rots: it names a plan, in a component, about a route.
 */
import type { EntitlementKey } from './entitlements.js';

export const CAPABILITIES = [
  /* Shared: every paid product, and the trial. */
  'DASHBOARD_READ',
  'MANUAL_BOOKKEEPING',
  'REPORTING',
  'PAYMENT_CONNECTIONS',
  'FINANCIAL_ACCOUNT_CONNECTIONS',
  'RECONCILIATION',

  /* Rekoda Chat: the merchant's conversational operating interface. */
  'CONVERSATIONAL_BOOKKEEPING',
  'VOICE_BOOKKEEPING',
  'DOCUMENT_UNDERSTANDING',
  'FINANCIAL_QA',

  /* Rekoda Integrate: the customer's side of the merchant's commerce. */
  'CUSTOMER_COMMERCE',
  'CATALOGUE',
  'WABA_CONNECTION',
  'CUSTOMER_ORDER_AUTOMATION',
  'TEMPLATE_AUTOMATION',
  'AWAY_ASSISTANT',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * `SHARED` means the dashboard control plane: any plan that is not lapsed.
 * Anything else names the entitlement that carries it.
 */
export type CapabilitySource = 'SHARED' | EntitlementKey;

export const CAPABILITY_SOURCE: Record<Capability, CapabilitySource> = {
  DASHBOARD_READ: 'SHARED',
  MANUAL_BOOKKEEPING: 'SHARED',
  REPORTING: 'SHARED',
  PAYMENT_CONNECTIONS: 'SHARED',
  FINANCIAL_ACCOUNT_CONNECTIONS: 'SHARED',
  RECONCILIATION: 'SHARED',

  CONVERSATIONAL_BOOKKEEPING: 'REKODA_CHAT',
  VOICE_BOOKKEEPING: 'REKODA_CHAT',
  DOCUMENT_UNDERSTANDING: 'REKODA_CHAT',
  FINANCIAL_QA: 'REKODA_CHAT',

  CUSTOMER_COMMERCE: 'REKODA_INTEGRATE',
  CATALOGUE: 'REKODA_INTEGRATE',
  WABA_CONNECTION: 'REKODA_INTEGRATE',
  CUSTOMER_ORDER_AUTOMATION: 'REKODA_INTEGRATE',
  TEMPLATE_AUTOMATION: 'REKODA_INTEGRATE',
  AWAY_ASSISTANT: 'REKODA_INTEGRATE',
};

/**
 * Does this business hold this capability?
 *
 * A lapsed plan keeps `DASHBOARD_READ` and loses everything else. Spec §4.5:
 * downgrade never destroys records, existing invoices remain collectible and
 * existing statements remain correct and exportable. A merchant whose trial
 * ended still owns their books, and a product that locks somebody out of
 * their own accounts to sell them a plan has stopped being a bookkeeper.
 */
export function hasCapability(
  capability: Capability,
  plan: string,
  entitlements: readonly EntitlementKey[],
): boolean {
  const source = CAPABILITY_SOURCE[capability];
  if (source === 'SHARED') return plan !== 'expired' || capability === 'DASHBOARD_READ';
  return entitlements.includes(source);
}

/** Everything this business can do, for a page that has to decide many things. */
export function capabilitiesFor(
  plan: string,
  entitlements: readonly EntitlementKey[],
): Capability[] {
  return CAPABILITIES.filter((capability) => hasCapability(capability, plan, entitlements));
}

/**
 * What a merchant is told when they reach something their plan does not
 * carry: what is unavailable, why, and which plan would change it.
 *
 * Three sentences, in that order, because the design system's
 * `EntitlementRefusal` owes exactly those three and a refusal missing the
 * third is a dead end rather than a doorway.
 */
export interface CapabilityRefusal {
  readonly capability: Capability;
  /** The capability in the words a merchant uses for it. */
  readonly what: string;
  /** Why it is not there, without blaming them for arriving. */
  readonly why: string;
  /** The plans that carry it, named. */
  readonly availableOn: readonly string[];
}

const CAPABILITY_WORDS: Record<Capability, string> = {
  DASHBOARD_READ: 'your dashboard',
  MANUAL_BOOKKEEPING: 'recording sales, expenses and stock',
  REPORTING: 'your reports and statements',
  PAYMENT_CONNECTIONS: 'payment connections',
  FINANCIAL_ACCOUNT_CONNECTIONS: 'bank connections',
  RECONCILIATION: 'reconciliation',

  CONVERSATIONAL_BOOKKEEPING: 'recording by message',
  VOICE_BOOKKEEPING: 'voice-note bookkeeping',
  DOCUMENT_UNDERSTANDING: 'reading documents you send',
  FINANCIAL_QA: 'asking Rekoda about your books',

  CUSTOMER_COMMERCE: 'automatic order capture',
  CATALOGUE: 'your catalogue',
  WABA_CONNECTION: 'connecting your WhatsApp Business number',
  CUSTOMER_ORDER_AUTOMATION: 'orders captured from your customers',
  TEMPLATE_AUTOMATION: 'automatic customer messages',
  AWAY_ASSISTANT: 'the away assistant',
};

const SOURCE_PLANS: Record<CapabilitySource, readonly string[]> = {
  SHARED: ['Rekoda Chat', 'Rekoda Integrate', 'Rekoda Complete'],
  REKODA_CHAT: ['Rekoda Chat', 'Rekoda Complete'],
  REKODA_INTEGRATE: ['Rekoda Integrate', 'Rekoda Complete'],
  REKODA_API: ['Rekoda Complete'],
};

/**
 * Why this capability is unavailable, in the merchant's terms.
 *
 * The `why` never says "you did not pay for it". A merchant on Integrate did
 * pay, for something else, and telling them what they DO have is the
 * difference between a refusal that reads as a boundary and one that reads
 * as a punishment.
 */
export function refusalFor(capability: Capability, plan: string): CapabilityRefusal {
  const source = CAPABILITY_SOURCE[capability];
  const why =
    source === 'SHARED'
      ? 'Your plan has ended, so new records are paused. Everything you already recorded is still here.'
      : source === 'REKODA_CHAT'
        ? 'This is part of Rekoda Chat, the way you talk to Rekoda. Your dashboard and your records are unchanged.'
        : 'This is part of Rekoda Integrate, which connects your customers to Rekoda. Your dashboard and your records are unchanged.';
  return {
    capability,
    what: CAPABILITY_WORDS[capability],
    why,
    availableOn: SOURCE_PLANS[source].filter((name) => name !== planName(plan)),
  };
}

function planName(plan: string): string {
  return (
    { chat: 'Rekoda Chat', integrate: 'Rekoda Integrate', complete: 'Rekoda Complete' }[plan] ?? ''
  );
}

/* ── switching plan ───────────────────────────────────────────────────────── */

/**
 * What changes when a merchant moves between plans.
 *
 * A SWITCH, not a downgrade. Chat to Integrate both gains and loses, and
 * calling that a downgrade tells a merchant the wrong thing about a decision
 * they are making on purpose. Only the direction of each capability matters,
 * and both directions are shown (owner decision, 26 Aug 2026).
 */
export interface PlanSwitch {
  readonly from: string;
  readonly to: string;
  readonly gained: readonly Capability[];
  readonly lost: readonly Capability[];
  /** Whether anything is lost at all, which is what triggers the review. */
  readonly removesCapability: boolean;
}

export function planSwitch(
  from: string,
  to: string,
  entitlementsOf: (plan: string) => readonly EntitlementKey[],
): PlanSwitch {
  const before = new Set(capabilitiesFor(from, entitlementsOf(from)));
  const after = new Set(capabilitiesFor(to, entitlementsOf(to)));
  return {
    from,
    to,
    gained: CAPABILITIES.filter((c) => after.has(c) && !before.has(c)),
    lost: CAPABILITIES.filter((c) => before.has(c) && !after.has(c)),
    removesCapability: CAPABILITIES.some((c) => before.has(c) && !after.has(c)),
  };
}

/** A capability in the words a merchant uses, for the impact review. */
export function capabilityWords(capability: Capability): string {
  return CAPABILITY_WORDS[capability];
}
