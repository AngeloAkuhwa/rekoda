/**
 * Plan allowances (docs/metering-v1.md) — the numbers the meter enforces.
 *
 * One authoritative table, in core, so the pricing page and the enforcement
 * gate can never quote different figures. Merchants see these units; they
 * never see tokens (pricing-model commercial rule 3). Router-served turns
 * are free by design and no unit exists for them.
 */

export const USAGE_UNITS = [
  /* Chat: what a merchant spends recording their own books. */
  'AI_ACTIONS',
  'VOICE_MINUTES',
  'DOCUMENT_GENERATION',
  'DOCUMENTS_UNDERSTOOD',
  /* WhatsApp message categories. Meta prices these apart, and the spread
   * between utility and marketing is roughly eightfold, which makes it the
   * largest single variable in plan margin. Metering them as one number
   * hides the only figure worth watching (spec 4.2). */
  'SERVICE_MESSAGE',
  'UTILITY_TEMPLATE',
  'AUTH_TEMPLATE',
  'AUTH_INTL_TEMPLATE',
  'MARKETING_TEMPLATE',
  /* Integrate: what a customer's shopping spends. */
  'CATALOGUE_ORDERS',
  /* Standing capacity: connections held, people admitted. See UNIT_KIND. */
  'PAYMENT_CONNECTIONS',
  'FINANCIAL_ACCOUNT_CONNECTIONS',
  'ACCOUNTANT_USERS',
  'REPORT_EXPORTS',
  /* The API product (spec 27). */
  'API_REQUEST_UNITS',
  'API_APPLICATIONS',
  'WEBHOOK_DELIVERIES',
] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/**
 * The two kinds of allowance, named because conflating them produces a
 * product nobody wants (owner ruling, 28 August 2026).
 *
 * A **CONSUMABLE_MONTHLY** unit is spent and reset. Sending a message,
 * generating a document, making an API request: the merchant used something
 * up, next month they get the allowance again, and a pack tops it up in the
 * month it was bought.
 *
 * A **CAPACITY** unit is held, not spent. A merchant does not "consume" an
 * API application or an accountant seat — they are permitted to MAINTAIN
 * some number of them at once. The ceiling is checked against how many
 * currently exist, so deleting one frees the slot immediately, and a month
 * boundary means nothing to it.
 *
 * The distinction is load-bearing in three places:
 *
 *   `consumeUnit` is for consumables only. Running a capacity unit through
 *   it produces the bug this table exists to prevent: PR-113 metered
 *   `API_APPLICATIONS` as a monthly tally, so a merchant who registered
 *   their allowance of applications and then deleted every one of them
 *   still could not register another until the month turned over. A
 *   capacity ceiling is answered by counting what is there.
 *
 *   Capacity is sold as a RECURRING add-on, never as a one-off pack. "Buy
 *   fifty more applications, once" is not a sentence about standing
 *   capacity, and a pack that credits bonus into one month cannot express
 *   a permanent seat.
 *
 *   A capacity unit's counter row would be a lie: `usage_counters.used`
 *   means "spent this period", and a held thing is not spent.
 */
export const UNIT_KINDS = ['CONSUMABLE_MONTHLY', 'CAPACITY'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const UNIT_KIND: Record<UsageUnit, UnitKind> = {
  AI_ACTIONS: 'CONSUMABLE_MONTHLY',
  VOICE_MINUTES: 'CONSUMABLE_MONTHLY',
  DOCUMENT_GENERATION: 'CONSUMABLE_MONTHLY',
  DOCUMENTS_UNDERSTOOD: 'CONSUMABLE_MONTHLY',
  SERVICE_MESSAGE: 'CONSUMABLE_MONTHLY',
  UTILITY_TEMPLATE: 'CONSUMABLE_MONTHLY',
  AUTH_TEMPLATE: 'CONSUMABLE_MONTHLY',
  AUTH_INTL_TEMPLATE: 'CONSUMABLE_MONTHLY',
  MARKETING_TEMPLATE: 'CONSUMABLE_MONTHLY',
  CATALOGUE_ORDERS: 'CONSUMABLE_MONTHLY',
  /* An export is produced and gone: the merchant has the file. Grouped with
   * the connections above by an older comment, which was wrong about this
   * one and is corrected here. */
  REPORT_EXPORTS: 'CONSUMABLE_MONTHLY',
  API_REQUEST_UNITS: 'CONSUMABLE_MONTHLY',
  WEBHOOK_DELIVERIES: 'CONSUMABLE_MONTHLY',

  ACCOUNTANT_USERS: 'CAPACITY',
  PAYMENT_CONNECTIONS: 'CAPACITY',
  FINANCIAL_ACCOUNT_CONNECTIONS: 'CAPACITY',
  API_APPLICATIONS: 'CAPACITY',
};

/** Every unit of one kind. The list a gate iterates rather than retypes. */
export function unitsOfKind(kind: UnitKind): UsageUnit[] {
  return USAGE_UNITS.filter((unit) => UNIT_KIND[unit] === kind);
}

/** May this unit go through the monthly meter at all? */
export function isConsumable(unit: UsageUnit): boolean {
  return UNIT_KIND[unit] === 'CONSUMABLE_MONTHLY';
}

/**
 * How many counts the meter stores for one merchant-facing unit.
 *
 * Voice is the only unit whose merchant word and countable increment differ.
 * A voice note is not a whole number of minutes, and rounding each one up to
 * the next minute would cost a merchant sending twenty-second notes three
 * times the capacity they were sold. So `usage_counters.used` holds seconds
 * and the plan table below holds minutes, which is also the figure the
 * pricing page quotes.
 *
 * Every unit is named rather than defaulted, so adding an eighteenth forces
 * a decision about how it is counted instead of inheriting one.
 */
export const UNIT_SCALE: Record<UsageUnit, number> = {
  AI_ACTIONS: 1,
  VOICE_MINUTES: 60,
  DOCUMENT_GENERATION: 1,
  DOCUMENTS_UNDERSTOOD: 1,
  SERVICE_MESSAGE: 1,
  UTILITY_TEMPLATE: 1,
  AUTH_TEMPLATE: 1,
  AUTH_INTL_TEMPLATE: 1,
  MARKETING_TEMPLATE: 1,
  CATALOGUE_ORDERS: 1,
  PAYMENT_CONNECTIONS: 1,
  FINANCIAL_ACCOUNT_CONNECTIONS: 1,
  ACCOUNTANT_USERS: 1,
  REPORT_EXPORTS: 1,
  API_REQUEST_UNITS: 1,
  API_APPLICATIONS: 1,
  WEBHOOK_DELIVERIES: 1,
};

/**
 * `expired` is not sold — it is where a trial lands when its 30 days are up.
 * Modelling it as a plan rather than a flag means the gate needs no new
 * branch: every allowance is zero, so the atomic consume refuses the first
 * unit exactly as it refuses the 51st.
 */
export type PlanId = 'trial' | 'expired' | 'chat' | 'integrate' | 'complete';

/** A trial is 30 days from the day the business was created. */
export const TRIAL_DAYS = 30;

/** When a trial started at this moment runs out. */
export function trialExpiry(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TRIAL_DAYS * 86_400_000);
}

/**
 * What one plan sells, unit by unit.
 *
 * A unit left out of the object is not sold on that plan, which the meter
 * enforces as an allowance of zero: the atomic consume refuses the first
 * unit exactly as it refuses the 401st. Naming only what a plan sells keeps
 * the table readable against the pricing page, and means a new unit arrives
 * unsold everywhere until somebody decides its number.
 */
/**
 * `0` MEANS ZERO. It never means unlimited.
 *
 * Written here because the opposite convention is common enough that someone
 * will eventually assume it, and a meter that reads zero as unlimited hands
 * out a plan's worth of capacity to every merchant who was sold none. If an
 * unlimited allowance is ever needed it gets its own representation rather
 * than overloading a number.
 *
 * A zero allowance is also not the only thing standing between a merchant and
 * a capability. Entitlement, allowance, feature readiness and provider
 * readiness each have to permit execution independently; a unit going
 * positive does not make a half-built capability reachable.
 */
function sells(sold: Partial<Record<UsageUnit, number>>): Record<UsageUnit, number> {
  return Object.fromEntries(USAGE_UNITS.map((unit) => [unit, sold[unit] ?? 0])) as Record<
    UsageUnit,
    number
  >;
}

/**
 * The plan table, in the units a merchant is sold: minutes of voice, not
 * seconds. `allowanceFor` converts to the counts the meter stores.
 *
 * Eleven of the seventeen canonical units are zero on every plan today.
 * That is not an oversight and not a placeholder price of nothing: no code
 * consumes them yet, so there is no capability behind them to sell; the API
 * units get theirs with the API product. UTILITY_TEMPLATE got its numbers
 * when PR-060 started metering template sends — straight from
 * pricing-model.md, which is the page these figures must never disagree
 * with. MARKETING_TEMPLATE stays zero on EVERY plan by decision, not
 * omission: pricing-model.md excludes bulk WhatsApp marketing from V1
 * entirely, and zero means zero. AUTH templates are Rekoda's own platform
 * sends (sign-in codes), a platform cost rather than merchant capacity.
 */
export const PLAN_ALLOWANCES: Record<PlanId, Record<UsageUnit, number>> = {
  /* Ten orders on trial, not zero: MASTER-PLAN allows the Integrate
   * connection during trial, and a trialist who never tastes automatic
   * order capture never learns why Integrate is worth paying for. */
  trial: sells({
    AI_ACTIONS: 50,
    VOICE_MINUTES: 10,
    DOCUMENT_GENERATION: 25,
    DOCUMENTS_UNDERSTOOD: 10,
    CATALOGUE_ORDERS: 10,
  }),
  expired: sells({}),
  chat: sells({
    AI_ACTIONS: 400,
    VOICE_MINUTES: 60,
    DOCUMENT_GENERATION: 100,
    DOCUMENTS_UNDERSTOOD: 50,
    /* pricing-model.md's "25 utility reminders": payment reminders and
     * account notices that must reach a customer OUTSIDE the 24-hour
     * window, which is what a utility template is for. */
    UTILITY_TEMPLATE: 25,
  }),
  /**
   * Integrate holds REKODA_INTEGRATE and not REKODA_CHAT (owner decision,
   * 26 Aug 2026, spec 3.3). The merchant-side units are therefore absent:
   * the gate refuses those capabilities, so capacity for them would be
   * capacity the product cannot spend, and the pricing page must not promise
   * it.
   *
   * `DOCUMENT_GENERATION` stays, and is the reason this is not simply "zero
   * the Chat units": generating a document is what turns a customer order
   * into an invoice and a receipt, so it is Integrate's own consumable.
   *
   * This does mean the ladder walks backwards for a Chat merchant who moves
   * to Integrate: they lose merchant-side messaging, voice and document
   * understanding. That was the accepted cost of keeping Complete a
   * capability tier rather than a volume tier. Complete is the plan for a
   * merchant who wants both.
   */
  integrate: sells({
    DOCUMENT_GENERATION: 500,
    CATALOGUE_ORDERS: 300,
    /* pricing-model.md: "100 utility templates". */
    UTILITY_TEMPLATE: 100,
  }),
  complete: sells({
    AI_ACTIONS: 1_200,
    VOICE_MINUTES: 120,
    DOCUMENT_GENERATION: 750,
    DOCUMENTS_UNDERSTOOD: 200,
    CATALOGUE_ORDERS: 300,
    /* pricing-model.md: "150 utility templates". */
    UTILITY_TEMPLATE: 150,
  }),
};

/**
 * Team seats beyond the owner, per plan (pricing-model.md's "owner + N").
 *
 * Enforced at the invite endpoint the same way allowances are enforced at
 * the meter: the pricing page and the refusal quote one table, so they can
 * never disagree. `expired` is zero for the same reason its allowances are:
 * a lapsed business keeps its books readable and grows nothing.
 */
export const SEATS_PER_PLAN: Record<PlanId, number> = {
  trial: 1,
  expired: 0,
  chat: 1,
  integrate: 2,
  complete: 3,
};

/** An unknown plan gets the TRIAL seat count: the safe direction is stingy. */
export function seatsFor(plan: string): number {
  return (SEATS_PER_PLAN as Record<string, number>)[plan] ?? SEATS_PER_PLAN.trial;
}

/**
 * The allowance in the counts the meter stores, which is what every consume
 * site and every meter reading needs.
 *
 * An unknown plan gets the TRIAL allowance: the safe direction is stingy, and
 * a corrupted or future plan value must never mean unlimited.
 */
export function allowanceFor(plan: string, unit: UsageUnit): number {
  const known = (PLAN_ALLOWANCES as Record<string, Record<UsageUnit, number>>)[plan];
  return (known ? known[unit] : PLAN_ALLOWANCES.trial[unit]) * UNIT_SCALE[unit];
}

/**
 * The billing month, as merchants experience it: a calendar month in
 * Africa/Lagos. Lagos is fixed UTC+1 with no daylight saving, so the shift
 * is arithmetic, not a timezone database.
 */
export function usagePeriod(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 7);
}

/**
 * The billing month before this one.
 *
 * Arithmetic on the label rather than on a Date, so December rolls back to
 * November of the previous year without anybody reasoning about it, and
 * `2026-01` gives `2025-12` rather than a month that does not exist.
 */
export function periodBefore(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 2, 1)).toISOString().slice(0, 7);
}

/**
 * What each plan costs, in kobo (docs/pricing-model.md).
 *
 * These lived only in prose — the pricing page, the marketing copy and this
 * repository's own ADRs each carried a figure typed by hand, and one of them
 * was wrong for a day. A plan price is arithmetic input: the margin view
 * divides by it, and self-service billing (M4) will charge it. It belongs
 * beside the allowances it buys.
 *
 * `trial` and `expired` are zero because nobody is billed for either. That is
 * not a placeholder: a trial genuinely earns nothing, and the margin view
 * should show it as the cost centre it is rather than hiding it.
 */
export const PLAN_PRICES_K: Record<PlanId, number> = {
  trial: 0,
  expired: 0,
  chat: 990_000,
  integrate: 1_990_000,
  complete: 2_990_000,
};

/** An unknown plan earns nothing, which is the safe direction for a margin. */
export function planPriceK(plan: string): number {
  return (PLAN_PRICES_K as Record<string, number>)[plan] ?? 0;
}

/**
 * Meta's three template categories (spec §24; migration 0088 makes them the
 * only registrable values). SERVICE is deliberately not here: a service
 * message is a free-form reply INSIDE the 24-hour window, and a template is
 * what one sends because there is no window to be inside.
 */
export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * The §4.2 unit a template send meters to, derived at SEND time and never
 * stored (spec §24): the categories are separated because their provider
 * costs differ by nearly eightfold, and that difference is the largest
 * variable in plan margin.
 *
 * AUTHENTICATION splits by DESTINATION, because that is how Meta prices it:
 * a code to a Nigerian number is AUTH_TEMPLATE, anywhere else is
 * AUTH_INTL_TEMPLATE. `to` must already be normalised E.164 — this function
 * classifies, it does not parse, and a half-normalised number misfiled as
 * domestic is a mispriced unit.
 */
export function templateUnitFor(category: TemplateCategory, to: string): UsageUnit {
  switch (category) {
    case 'UTILITY':
      return 'UTILITY_TEMPLATE';
    case 'MARKETING':
      return 'MARKETING_TEMPLATE';
    case 'AUTHENTICATION':
      return to.startsWith('+234') ? 'AUTH_TEMPLATE' : 'AUTH_INTL_TEMPLATE';
  }
}
