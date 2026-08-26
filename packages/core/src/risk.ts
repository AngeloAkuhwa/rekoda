/**
 * What a command demands before it acts (canonical spec Appendix D).
 *
 * Entitlement decides whether a capability EXISTS for a business. Risk tier
 * decides what it DEMANDS. Without the second, reversing a period close is as
 * cheap as asking for a sales figure, and the difference between those two
 * things is the difference between a bookkeeper and an accident.
 *
 * The tier lives on the COMMAND and nowhere else. Appendix D.3 is explicit
 * about why: "a tier that a controller could soften would not be a tier". So
 * this table is the only source, `riskOf` takes a command name rather than a
 * tier, and there is deliberately no way for an ingress to pass one in. Chat,
 * the dashboard, the storefront, a future public API and every background
 * sweep read the same answer or they do not get one.
 */

export const RISK_TIERS = ['READ_ONLY', 'STANDARD', 'HIGH_RISK'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

/** Ordered, so "never lower than" is arithmetic rather than a chain of ifs. */
const TIER_ORDER: Record<RiskTier, number> = { READ_ONLY: 0, STANDARD: 1, HIGH_RISK: 2 };

/** The higher of two tiers. Escalation only ever moves one way. */
export function higherTier(a: RiskTier, b: RiskTier): RiskTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

/**
 * Every command Rekoda knows, with the tier it is born at.
 *
 * Names come from spec §25's command list and Appendix D.2's high-risk list,
 * plus the chat intents that exist today. A command absent from this table is
 * not "unclassified": `riskOf` treats it as `HIGH_RISK`, because the failure
 * mode of forgetting to classify something must be a command that is harder
 * to run than it needs to be, never one that is easier.
 */
export const COMMAND_RISK = {
  /* Reads. Never gated by confirmation; reading is never gated at all. */
  Query: 'READ_ONLY',
  ReadReport: 'READ_ONLY',
  ReadStatement: 'READ_ONLY',
  ListInvoices: 'READ_ONLY',
  ReadCustomerBalance: 'READ_ONLY',
  ReadStock: 'READ_ONLY',
  Unclear: 'READ_ONLY',

  /* The ordinary business of bookkeeping: a preview, then a yes. */
  RecordSale: 'STANDARD',
  RecordPayment: 'STANDARD',
  RecordExpense: 'STANDARD',
  RecordPurchase: 'STANDARD',
  RecordOrder: 'STANDARD',
  PlaceOrder: 'STANDARD',
  IssueInvoice: 'STANDARD',
  CreatePaymentIntent: 'STANDARD',
  ConfirmPayment: 'STANDARD',
  AllocatePayment: 'STANDARD',
  RecordPaymentEvidence: 'STANDARD',
  IngestFinancialTransaction: 'STANDARD',
  AdjustInventory: 'STANDARD',
  ConfirmReconciliation: 'STANDARD',
  PostJournal: 'STANDARD',
  ClosePeriod: 'STANDARD',
  DeactivateAccount: 'STANDARD',
  ChangePaymentConnection: 'STANDARD',

  /* Appendix D.2, verbatim in meaning: money leaving, trust unpicked,
   * documents already in a customer's hands, figures made movable again. */
  RefundPayment: 'HIGH_RISK',
  VoidReceipt: 'HIGH_RISK',
  RevokePaymentVerification: 'HIGH_RISK',
  ReopenAccountingPeriod: 'HIGH_RISK',
  EraseData: 'HIGH_RISK',
  ChangePostingAccountPolicy: 'HIGH_RISK',
  DisconnectPaymentConnection: 'HIGH_RISK',
  ChangePaymentConnectionCredential: 'HIGH_RISK',
  ChangePaymentConnectionProvider: 'HIGH_RISK',
} as const satisfies Record<string, RiskTier>;

export type CommandName = keyof typeof COMMAND_RISK;

/**
 * The facts about a particular invocation that can RAISE its tier.
 *
 * Four of Appendix D.2's entries are not commands but commands in a
 * particular shape: a reconciliation OVERRIDE, an inventory adjustment that
 * writes stock off, deactivating an account the chart of accounts requires, a
 * journal posted by hand where policy demands review. Modelling those as
 * separate command names would have meant an ingress choosing which name to
 * send, which is the softening Appendix D.3 forbids. They are the same
 * command carrying a fact about itself.
 */
export interface RiskContext {
  /** Overruling a deterministic match rather than accepting one. */
  readonly overriding?: boolean;
  /** Stock written off, or forced to a count, rather than counted up. */
  readonly destructive?: boolean;
  /** The account being deactivated is one the chart of accounts requires. */
  readonly mandatoryRole?: boolean;
  /** A journal entered by hand where the posting policy demands review. */
  readonly manual?: boolean;
}

/**
 * What this invocation demands.
 *
 * An unknown command is `HIGH_RISK`. That is not paranoia: a command that
 * reaches this function without a row above is a command somebody added and
 * forgot to classify, and the safe reading of a forgotten classification is
 * the strictest one.
 *
 * Context can only ever RAISE the answer. There is no shape of an invocation
 * that makes a refund cheaper.
 */
export function riskOf(command: string, context: RiskContext = {}): RiskTier {
  const base = (COMMAND_RISK as Record<string, RiskTier>)[command];
  if (base === undefined) return 'HIGH_RISK';

  let tier = base;
  if (context.overriding && command === 'ConfirmReconciliation') {
    tier = higherTier(tier, 'HIGH_RISK');
  }
  if (context.destructive && command === 'AdjustInventory') {
    tier = higherTier(tier, 'HIGH_RISK');
  }
  if (context.mandatoryRole && command === 'DeactivateAccount') {
    tier = higherTier(tier, 'HIGH_RISK');
  }
  if (context.manual && command === 'PostJournal') {
    tier = higherTier(tier, 'HIGH_RISK');
  }
  return tier;
}

/**
 * Commands whose confirmation must be an exact PHRASE, not a yes.
 *
 * Appendix D.2 singles one out: "EraseData — exact-phrase confirmation, never
 * 'yes'". The distinction is real and worth the extra type. A yes is a reflex
 * on a phone in a shop; typing five words is a decision. Everything else in
 * the HIGH_RISK list is undoable by somebody, eventually, at some cost.
 * Erasing a merchant's customers is not undoable by anybody.
 *
 * The phrase is upper case because that is how the reply asks for it, and
 * `matchesPhrase` compares case-insensitively on trimmed text: a merchant who
 * types it in lower case meant it just as much.
 */
export const CONFIRMATION_PHRASE = {
  EraseData: 'DELETE MY DATA',
} as const satisfies Partial<Record<CommandName, string>>;

/** The phrase this command demands, or null if a confirmation is enough. */
export function phraseFor(command: string): string | null {
  return (CONFIRMATION_PHRASE as Record<string, string>)[command] ?? null;
}

/** Did they type it? Trimmed and case-insensitive, and nothing looser. */
export function matchesPhrase(command: string, typed: string): boolean {
  const phrase = phraseFor(command);
  if (phrase === null) return false;
  return typed.trim().toUpperCase() === phrase;
}

/**
 * Every front door, named, because Appendix D.3's rule is that none of them
 * gets a cheaper path and a rule about "every ingress" needs the list of
 * ingresses to be somewhere.
 *
 * `AWAY_ASSISTANT` has no caller yet: the away assistant is W4. It is here
 * now because the rule about it is absolute, and a rule written after the
 * thing it governs is a rule that arrives late.
 */
export const INGRESSES = [
  'CHAT',
  'DASHBOARD',
  'STOREFRONT',
  'WABA',
  'PUBLIC_API',
  'EMBED',
  'AUTOMATION',
  'AWAY_ASSISTANT',
] as const;
export type Ingress = (typeof INGRESSES)[number];

/**
 * May an unattended assistant run this by itself?
 *
 * Appendix D.3: never, for anything `HIGH_RISK`, "including when the merchant
 * has performed that same action manually before. Past manual use is not
 * standing consent for an unattended agent." So this asks the tier and
 * nothing else. There is deliberately no parameter for history, no allowlist
 * and no override, because every one of those is the mechanism by which an
 * absolute rule stops being absolute.
 */
export function awayAssistantMayExecute(command: string, context: RiskContext = {}): boolean {
  return riskOf(command, context) !== 'HIGH_RISK';
}

/** Why a request was refused, in the shape a caller can act on. */
export type RiskRefusal =
  | { readonly kind: 'AWAY_ASSISTANT_FORBIDDEN'; readonly command: string }
  | { readonly kind: 'CONFIRMATION_REQUIRED'; readonly command: string }
  | { readonly kind: 'CONFIRMATION_EXPIRED'; readonly command: string }
  | { readonly kind: 'CONFIRMATION_ALREADY_USED'; readonly command: string }
  | { readonly kind: 'REASON_REQUIRED'; readonly command: string };

/**
 * How long a high-risk confirmation stands before it must be asked again.
 *
 * Five minutes: long enough to read a consequence and decide, short enough
 * that a phone left on a counter is not an open authorisation. Appendix D
 * does not fix a number, so this is an implementation decision recorded here
 * rather than an invented canonical one.
 */
export const CONFIRMATION_TTL_SECONDS = 300;
