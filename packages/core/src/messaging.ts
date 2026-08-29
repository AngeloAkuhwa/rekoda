/**
 * What an outbound WhatsApp message costs Rekoda, by category.
 *
 * Spec §24: "Message categories are metered separately (§4.2) because utility
 * and marketing differ by roughly eightfold in cost, and that difference is
 * the largest variable in plan margin." Until this file existed the code had
 * one bucket, `message_out`, for every outbound message, so the difference
 * the specification calls the largest variable in plan margin was the one
 * thing the margin view could not see.
 *
 * These are REKODA's costs, not merchant allowances. Commercial rule 3 of
 * docs/pricing-model.md is explicit: merchants see concrete units, and
 * "infrastructure units (tokens, STT minutes, template fees) are tracked
 * internally per business". Every message Rekoda sends today goes out over
 * Rekoda's own number to the merchant, so charging a merchant's allowance for
 * a billing reminder or a sign-in code would bill them for Rekoda talking to
 * them. The allowance side of these units belongs to merchant-owned WABAs and
 * arrives with W1/W2, where a merchant messages their OWN customer and the
 * category is chosen at send time.
 */
import type { UsageUnit } from './allowances.js';

/**
 * The five categories Meta prices apart, which are also five of the seventeen
 * canonical metered units (spec §4.2).
 *
 * `satisfies` rather than a comment: a category that stops being a metered
 * unit, or a unit renamed out from under one, fails the build here instead of
 * writing rows the meter cannot hold.
 */
export const MESSAGE_CATEGORIES = [
  'SERVICE_MESSAGE',
  'UTILITY_TEMPLATE',
  'AUTH_TEMPLATE',
  'AUTH_INTL_TEMPLATE',
  'MARKETING_TEMPLATE',
] as const satisfies readonly UsageUnit[];

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

/**
 * A provider's rates, as they stood on a date.
 *
 * Effective-dated rather than absolute because a rate card is an observation
 * with a date on it, not a domain truth. Meta reprices; the schedule gains a
 * version and everything derived from it moves with it.
 */
export interface ProviderCostSchedule {
  /** Which published card this is, so a cost report can name its source. */
  readonly version: string;
  /** When these rates took effect, ISO date. */
  readonly effectiveFrom: string;
  /** USD micros per message, by category. */
  readonly micros: Record<MessageCategory, number>;
}

/**
 * The rates Rekoda currently models, from the external cost stack in
 * docs/pricing-model.md (researched 16 Aug 2026, re-verified 24 Aug 2026).
 *
 * One table, in core, for the same reason the plan prices are: the margin
 * view, the pricing page and any future rate change must read one number. The
 * planning rule from that document applies here too, and is why nothing below
 * is rounded down: model every cost at or above market.
 */
export const META_COST_SCHEDULE: ProviderCostSchedule = {
  version: 'meta-ng-2026-08',
  effectiveFrom: '2026-08-24',
  micros: {
    /**
     * Free Meta-side today. Chargeable from 1 October 2026, which is why the
     * count has been written since before the price existed: a count that
     * starts on the day the price does has no baseline to compare against.
     * `META_SERVICE_REPLY_COST_MICROS` overrides this when the rate publishes.
     */
    SERVICE_MESSAGE: 0,
    /** ~$0.0067. Order updates, receipts, billing and retention notices. */
    UTILITY_TEMPLATE: 6_700,
    /** $0.0145 for a Nigeria-registered WABA. Sign-in codes. */
    AUTH_TEMPLATE: 14_500,
    /**
     * $0.0750 for the SAME message when the WABA is registered outside
     * Nigeria, and the reason docs/pricing-model.md carries the launch
     * requirement that the WABA be registered in Nigeria.
     *
     * The distinction is about where REKODA's WABA is registered, not where
     * the recipient's phone is. Reading it the other way round would price
     * every Nigerian merchant's OTP as international and every foreign one as
     * domestic, which is wrong twice.
     */
    AUTH_INTL_TEMPLATE: 75_000,
    /**
     * ~$0.0516. Nothing sends one: commercial rule 2 excludes bulk and
     * promotional WhatsApp from every V1 plan. The rate is here so that the
     * day something does, it is priced and visible rather than discovered on
     * an invoice.
     */
    MARKETING_TEMPLATE: 51_600,
  },
};

/** The rates in force. Kept as a name so callers do not reach into a version. */
export const MESSAGE_COST_MICROS: Record<MessageCategory, number> = META_COST_SCHEDULE.micros;

/**
 * How many times a category costs another, at a given schedule.
 *
 * DERIVED, never stored. Spec §24 justifies separating the categories on the
 * roughly eightfold gap between utility and marketing, and it would be easy
 * to write that multiple down as a constant. A written-down ratio is a number
 * that keeps its value after the rates it described have changed, which is
 * the quiet way a cost model starts lying. Meta reprices, this moves.
 */
export function costRatio(
  dearer: MessageCategory,
  cheaper: MessageCategory,
  schedule: ProviderCostSchedule = META_COST_SCHEDULE,
): number | null {
  const base = schedule.micros[cheaper];
  if (base === 0) return null;
  return schedule.micros[dearer] / base;
}

/**
 * Which authentication rate a sign-in code is billed at.
 *
 * A function rather than a constant because it is a deployment fact that a
 * misconfiguration can change, and getting it wrong is a fivefold error on
 * the single most expensive message Rekoda sends.
 */
export function authTemplateCategory(wabaRegisteredInNigeria: boolean): MessageCategory {
  return wabaRegisteredInNigeria ? 'AUTH_TEMPLATE' : 'AUTH_INTL_TEMPLATE';
}

/**
 * The same cost in KOBO, at planning FX.
 *
 * USD micros are what Meta quotes; kobo is what the margin view adds up. The
 * arithmetic is `micros × naira-per-USD ÷ 10,000`: micros to dollars is a
 * millionth, dollars to kobo is a hundred, and the two collapse.
 */
export function messageCostK(micros: number, nairaPerUsd: number): number {
  return Math.round((micros * nairaPerUsd) / 10_000);
}
