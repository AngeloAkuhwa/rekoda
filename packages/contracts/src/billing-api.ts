/**
 * Self-service billing, on the wire (ADR 0024).
 *
 * Every amount here is integer KOBO and was computed by `@rekoda/core/billing`
 * before it reached this boundary. Nothing on the web tier does money
 * arithmetic; these schemas are what keeps that true.
 */
import { z } from 'zod';

const kobo = z.number().int().finite().nonnegative();
const isoDate = z.string().datetime({ offset: true });

/** Where a merchant stands: active, in grace after a failed card, or expired. */
export const billingStateView = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active'), renewsAt: isoDate }),
  z.object({
    state: z.literal('grace'),
    endsAt: isoDate,
    daysLeft: z.number().int().nonnegative(),
  }),
  z.object({
    state: z.literal('expired'),
    since: isoDate,
    /** True when what ended was a free trial that was never paid for, not a subscription. */
    wasTrial: z.boolean(),
  }),
  /** A trial has no cycle and no card. It ends; it does not lapse. */
  z.object({ state: z.literal('trial'), endsAt: isoDate.nullable() }),
]);

/**
 * What a subscription charge can be, as the API and the page see it. It mirrors the
 * database's `ChargeStatus` and the CHECK on `subscription_charges.status` (migration
 * 0020); `charge-status-contract.test.ts` in the api fails to compile if they drift.
 */
export const billingChargeStatus = z.enum(['pending', 'paid', 'failed', 'refunded']);
export type BillingChargeStatus = z.infer<typeof billingChargeStatus>;

/** How a subscription bills (OWN-40): a month, or a year at ten months' price. */
export const billingInterval = z.enum(['monthly', 'annual']);
export type BillingIntervalView = z.infer<typeof billingInterval>;

export const billingChargeView = z.object({
  reference: z.string(),
  kind: z.enum(['first_purchase', 'renewal', 'upgrade', 'add_on', 'seat']),
  plan: z.string().nullable(),
  packId: z.string().nullable(),
  /** What the pack was called when it was bought (null for anything but a pack). */
  packLabel: z.string().nullable(),
  amountK: kobo,
  /** Part of the charge already returned. The status stays `paid` until all of it is (G-111). */
  refundedAmountK: kobo,
  status: billingChargeStatus,
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  /** What the charge bought: a month or a year of service (plan charges). */
  interval: billingInterval,
  /**
   * A pending charge the account has since replaced with a newer choice. It stays `pending` in the
   * history but can no longer be paid; a client never offers it (G-102 slice 2c).
   */
  superseded: z.boolean(),
  /**
   * A paid charge that took effect on the account. False for a payment that arrived but was
   * refused as stale (OD-30: money received, nothing applied, an operator reconciles it) and for
   * any charge that is not paid.
   */
  applied: z.boolean(),
  createdAt: isoDate,
});

/**
 * One payment to Rekoda in full (billing Slice A). Every field is read from the charge's own row
 * under the tenant pin; nothing is composed from the provider's response at read time. `paidAt`
 * is when Rekoda recorded the verified payment and is null for anything that is not paid; the
 * provider's own payment and settlement times and the units-credited time are separate (OD-40).
 */
export const billingPaymentState = z.enum([
  'awaiting_payment',
  'replaced',
  'failed',
  'paid_applied',
  'paid_not_applied',
  'part_refunded',
  'refunded',
]);

export const billingPaymentRecord = z.object({
  reference: z.string(),
  kind: z.enum(['first_purchase', 'renewal', 'upgrade', 'add_on', 'seat']),
  state: billingPaymentState,
  status: billingChargeStatus,
  plan: z.string().nullable(),
  packId: z.string().nullable(),
  packLabel: z.string().nullable(),
  /** Units a pack buys, or 1 for a plan charge. */
  quantity: z.number().int().positive(),
  interval: billingInterval,
  /** What was asked for, in kobo. */
  amountK: kobo,
  /** What the provider verified it took; null until a payment was verified. */
  paidAmountK: kobo.nullable(),
  refundedAmountK: kobo,
  currency: z.string(),
  /** The cycle the payment actually bought; null when it bought none or the cycle was not recorded. */
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  createdAt: isoDate,
  /** When Rekoda recorded the verified payment; null for anything that is not paid. */
  paidAt: isoDate.nullable(),
  /** OD-40: when Paystack says the payment happened (its verified `paid_at`); null when Paystack gave none. */
  providerPaidAt: isoDate.nullable(),
  /** OD-40: when Paystack confirmed the money settled; null until verified settlement evidence exists. */
  providerSettledAt: isoDate.nullable(),
  /** OD-40: when Rekoda added a pack's units to the account; null for a plan charge or before they were added. */
  unitsCreditedAt: isoDate.nullable(),
  failedAt: isoDate.nullable(),
  refundedAt: isoDate.nullable(),
  /** A verified payment that took effect on the account, whether or not it was later refunded. False for any unpaid state and for money received but refused as stale. */
  applied: z.boolean(),
  /** For `paid_not_applied`: an operator has since reconciled it. */
  reconciled: z.boolean(),
  /** An upgrade that cost nothing: applied with no payment taken and no provider involved. */
  noCharge: z.boolean(),
  /** Why a paid charge was not applied, in merchant-safe families; null when it was applied. */
  notAppliedReason: z.enum(['plan_changed', 'period_ended', 'under_review']).nullable(),
});
export type BillingPaymentRecord = z.infer<typeof billingPaymentRecord>;

export const billingUnitView = z.object({
  /**
   * The canonical seventeen (spec 4.2). Written out rather than imported so
   * the wire contract stays a literal that any client can read without
   * depending on the pricing engine.
   */
  unit: z.enum([
    'AI_ACTIONS',
    'VOICE_MINUTES',
    'DOCUMENT_GENERATION',
    'DOCUMENTS_UNDERSTOOD',
    'SERVICE_MESSAGE',
    'UTILITY_TEMPLATE',
    'AUTH_TEMPLATE',
    'AUTH_INTL_TEMPLATE',
    'MARKETING_TEMPLATE',
    'CATALOGUE_ORDERS',
    'PAYMENT_CONNECTIONS',
    'FINANCIAL_ACCOUNT_CONNECTIONS',
    'ACCOUNTANT_USERS',
    'REPORT_EXPORTS',
    'API_REQUEST_UNITS',
    'API_APPLICATIONS',
    'WEBHOOK_DELIVERIES',
  ]),
  used: z.number().int().nonnegative(),
  /** The plan's own allowance, before anything bought. */
  allowance: z.number().int().nonnegative(),
  /** Bought capacity for this month. Does not roll over. */
  bonus: z.number().int().nonnegative(),
});

export const billingPackView = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  quantity: z.number().int().positive(),
  priceK: kobo,
});

/**
 * A recurring add-on this business holds (PR-117).
 *
 * Distinct from a pack, and the page says so in as many words: a pack is
 * one month's top-up, an add-on is a subscription that grants the same
 * thing every month until it is ended. `endsAt` is a cancellation that has
 * not taken effect yet - the merchant paid for the month and keeps it.
 */
export const billingAddOnView = z.object({
  addOnId: z.string(),
  name: z.string(),
  startedAt: isoDate,
  endsAt: isoDate.nullable(),
});

export const billingOverviewResponse = z.object({
  plan: z.string(),
  /** The monthly price of the current plan. */
  priceK: kobo,
  /** What a year of the current plan costs: ten months' price (OWN-40). Zero without a paid price. */
  annualPriceK: kobo,
  /** The interval the current cycle was bought on. */
  interval: billingInterval,
  /** A switch of interval waiting for the next renewal, or null. */
  pendingInterval: billingInterval.nullable(),
  /** What each plan on sale costs this business now (the active catalogue, through its pin): a month and a year. */
  planPrices: z.array(z.object({ plan: z.string(), monthlyK: kobo, annualK: kobo })),
  /** Whether a year can be newly chosen (a first purchase or a switch to yearly). Off until annual billing is switched on. */
  annualOffered: z.boolean(),
  status: billingStateView,
  /** The plan the next renewal moves to, when a downgrade is waiting. */
  pendingPlan: z.string().nullable(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  units: z.array(billingUnitView),
  packs: z.array(billingPackView),
  /** Recurring add-ons held right now. Empty for most businesses. */
  addOns: z.array(billingAddOnView),
  /**
   * Every charge on this account, which is not `charges.length`.
   *
   * The page's empty state promises that every payment a merchant makes to
   * Rekoda will be listed with its reference "so you can put it in your own
   * books". A silent cap breaks that promise: somebody reconciling against
   * this list comes up short with nothing on the page to explain why.
   */
  chargesTotal: z.number().int().nonnegative(),
  charges: z.array(billingChargeView),
  /**
   * OWN-76: a Paystack update about a payment to Rekoda could not be processed and is with
   * Rekoda's team (a dead `billing.process` job). Null when there is none. It is a billing notice,
   * never a payment-reconciliation exception, and it claims nothing about whether money moved.
   */
  processingIssue: z
    .object({
      since: isoDate,
      /** An operator has verified it with Paystack and it is being processed again. */
      recovering: z.boolean(),
    })
    .nullable(),
});

/** What a plan change costs today, and when it takes effect. */
export const billingQuoteResponse = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['first_purchase', 'upgrade', 'downgrade', 'same']),
  amountK: kobo,
  effectiveFrom: z.enum(['now', 'next_renewal']),
  renewsAt: isoDate,
  /** OWN-33: a non-standard cycle is never prorated automatically; support handles it. */
  supportReview: z.boolean().default(false),
  /** The interval the amount buys (a first purchase can choose; any other change keeps the current one). */
  interval: billingInterval.default('monthly'),
});

/** Buying an add-on pack. The id is validated against the price list server side. */
export const billingPackPurchaseRequest = z.object({
  packId: z.string().min(1).max(64),
});
export type BillingPackPurchaseRequest = z.infer<typeof billingPackPurchaseRequest>;

/**
 * Pay one pending charge (G-102, OWN-39). The reference names the charge; the
 * billing email is needed only the first time, or to change it. The business
 * comes from the session, never from here.
 */
export const billingCheckoutRequest = z.object({
  reference: z.string().min(1).max(64),
  billingEmail: z.string().max(320).optional(),
  /**
   * The merchant lost the link or wants a fresh one (G-102, OWN-50). Honoured
   * only after Paystack confirms the existing session was not paid, and never
   * while a payment on it is under way.
   */
  restart: z.boolean().optional(),
});
export type BillingCheckoutRequest = z.infer<typeof billingCheckoutRequest>;

export const billingCheckoutResponse = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ready'),
    reference: z.string(),
    checkoutUrl: z.string().url(),
    amountK: kobo,
  }),
  /** No billing email on file and none given: ask for one inside the payment flow. */
  z.object({ state: z.literal('requires_billing_email') }),
  /** Live payments only: the address on file has not proven its mailbox yet (OWN-51). */
  z.object({ state: z.literal('requires_billing_email_verification'), maskedEmail: z.string() }),
  z.object({
    state: z.literal('invalid_billing_email'),
    reason: z.enum(['invalid', 'too_long', 'reserved']),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum([
      'unknown_charge',
      'not_pending',
      'superseded',
      'cycle_ended',
      'support_review',
      'nothing_to_pay',
      'payments_not_configured',
      'awaiting_platform_confirmation',
      'provider_rejected_billing_email',
      /** Paystack says this charge was already paid: the receipt is on its way, nothing more to pay. */
      'payment_received',
      /** A payment on the current session is under way at Paystack; wait for it to settle. */
      'payment_in_progress',
      /** Another request is starting this checkout right now; ask again in a moment. */
      'checkout_in_progress',
      /** The charge has used every checkout attempt; an operator reconciles it. */
      'too_many_attempts',
    ]),
  }),
]);
export type BillingCheckoutResponse = z.infer<typeof billingCheckoutResponse>;

/* ── proving the billing email's mailbox (G-102 slice 2b, OWN-51) ── */

export const billingEmailStatusResponse = z.object({
  /** The address with most of it hidden; the full address is never sent back. */
  maskedEmail: z.string().nullable(),
  verified: z.boolean(),
  /** False while no email sender is configured: the page says confirmation is unavailable. */
  canSend: z.boolean(),
  /**
   * The newest confirmation link that could still work, with how its hand-over to the email
   * provider ended: `uncertain` means the request timed out and the mail may or may not have gone.
   */
  outstandingLink: z
    .object({ sentAt: isoDate, delivery: z.enum(['accepted', 'uncertain', 'unknown']) })
    .nullable(),
});
export type BillingEmailStatusResponse = z.infer<typeof billingEmailStatusResponse>;

/** Send (or resend) the confirmation link; a new address may ride along and replaces the old one. */
export const billingEmailVerifyRequest = z.object({ billingEmail: z.string().max(320).optional() });
export const billingEmailVerifyResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('sent'), maskedEmail: z.string() }),
  /**
   * The provider's answer was lost: the link may or may not have been mailed. It stays valid, and
   * counts against the hourly allowance; `retryAfterSeconds` is when another may be asked for.
   */
  z.object({
    state: z.literal('delivery_uncertain'),
    maskedEmail: z.string(),
    retryAfterSeconds: z.number().int().nonnegative(),
  }),
  z.object({ state: z.literal('already_verified'), maskedEmail: z.string() }),
  z.object({ state: z.literal('requires_billing_email') }),
  z.object({
    state: z.literal('invalid_billing_email'),
    reason: z.enum(['invalid', 'too_long', 'reserved']),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum(['email_not_configured', 'send_failed', 'address_unusable']),
  }),
  /** Too many links asked for; `retryAfterSeconds` is when the next may be requested. */
  z.object({ state: z.literal('rate_limited'), retryAfterSeconds: z.number().int().nonnegative() }),
]);
export type BillingEmailVerifyRequest = z.infer<typeof billingEmailVerifyRequest>;
export type BillingEmailVerifyResponse = z.infer<typeof billingEmailVerifyResponse>;

export const billingEmailConfirmRequest = z.object({ token: z.string().min(16).max(128) });
export const billingEmailConfirmResponse = z.object({
  state: z.enum(['verified', 'invalid', 'expired', 'address_changed']),
});
export type BillingEmailConfirmRequest = z.infer<typeof billingEmailConfirmRequest>;
export type BillingEmailConfirmResponse = z.infer<typeof billingEmailConfirmResponse>;

export const billingPlanChangeRequest = z.object({
  plan: z.enum(['chat', 'integrate', 'complete']),
  /** Only a first purchase chooses; a subscriber switches interval through `billingIntervalRequest`. */
  interval: billingInterval.optional(),
});

/**
 * Switching between monthly and annual billing (OWN-40). Never immediate: the
 * switch waits for the next renewal, so a month or a year already paid for is
 * kept whole, and no credit or refund is invented.
 */
export const billingIntervalRequest = z.object({ interval: billingInterval });
export const billingIntervalResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('scheduled'), interval: billingInterval, effectiveAt: isoDate }),
  /** Choosing the interval already in force undoes a switch that was waiting. */
  z.object({ state: z.literal('undone'), interval: billingInterval }),
  z.object({ state: z.literal('unchanged'), interval: billingInterval }),
  /** A trial or lapsed plan has no cycle to switch (choose the interval when buying); a cancelled plan has no renewal to switch at. */
  z.object({ state: z.literal('unavailable'), reason: z.enum(['no_cycle', 'cancelling']) }),
]);
export type BillingIntervalRequest = z.infer<typeof billingIntervalRequest>;
export type BillingIntervalResponse = z.infer<typeof billingIntervalResponse>;

/**
 * What happened when a merchant asked to change plan.
 *
 * `scheduled` costs nothing and waits for the renewal. `applied` costs
 * nothing and has already happened. `payment_required`
 * has opened a charge that is not paid until a provider says so. `unavailable`
 * is the honest answer while production Paystack is gated (spec §47): no
 * charge is opened, so nothing has to be cleaned up when it lifts.
 */
export const billingPlanChangeResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('scheduled'), plan: z.string(), effectiveAt: isoDate }),
  /** An upgrade that costs nothing today (under a day left) is switched at once. */
  z.object({ state: z.literal('applied'), plan: z.string() }),
  z.object({
    state: z.literal('payment_required'),
    reference: z.string(),
    amountK: kobo,
    plan: z.string(),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum([
      'awaiting_platform_confirmation',
      /** The platform Paystack key is missing or of a shape Rekoda does not recognise (§47 gate). */
      'payments_not_configured',
      'no_cycle',
      'cycle_ended',
      'support_review',
    ]),
  }),
]);

export type BillingStateView = z.infer<typeof billingStateView>;
export type BillingChargeView = z.infer<typeof billingChargeView>;
export type BillingUnitView = z.infer<typeof billingUnitView>;
export type BillingPackView = z.infer<typeof billingPackView>;
export type BillingOverviewResponse = z.infer<typeof billingOverviewResponse>;
export type BillingQuoteResponse = z.infer<typeof billingQuoteResponse>;
export type BillingPlanChangeRequest = z.infer<typeof billingPlanChangeRequest>;
export type BillingPlanChangeResponse = z.infer<typeof billingPlanChangeResponse>;

/**
 * Cancelling the subscription (fix-plan 5, H2a).
 *
 * The terms and the refunds page have promised this since they were written;
 * this is the control they promised. Cancelling is a SCHEDULED stop, never
 * an immediate one: the merchant paid for the month, so they keep the month,
 * and at renewal the plan ends instead of charging. Records stay readable
 * and exportable afterwards, which the copy on the button says out loud.
 */
export const billingCancelResponse = z.discriminatedUnion('state', [
  /** The plan runs to the date shown, then stops. Nothing more is charged. */
  z.object({ state: z.literal('scheduled'), endsAt: isoDate }),
  /** Picking the current plan again on the change-plan table undoes this. */
  z.object({ state: z.literal('already_scheduled'), endsAt: isoDate }),
  /** A trial has nothing to cancel: it ends by itself and charges nothing. */
  z.object({ state: z.literal('trial'), endsAt: isoDate.nullable() }),
  z.object({ state: z.literal('already_stopped') }),
]);
export type BillingCancelResponse = z.infer<typeof billingCancelResponse>;

/**
 * The facts a business can correct about itself (fix-plan 5, H2a).
 *
 * Onboarding promised "you can change it" about the name and "later from
 * settings" about CAC and TIN; this is that request. Every field optional,
 * at least one required: an empty save is a click, not an instruction.
 */
export const businessSettingsRequest = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    /** CAC registration number. Empty string clears it: not registered yet. */
    rcNumber: z.string().trim().max(20).optional(),
    tin: z.string().trim().max(20).optional(),
  })
  .refine((v) => v.name !== undefined || v.rcNumber !== undefined || v.tin !== undefined, {
    message: 'change at least one thing',
  });

export const businessSettingsView = z.object({
  name: z.string(),
  rcNumber: z.string().nullable(),
  tin: z.string().nullable(),
  /** E.164 of the owner: shown, never editable, because it IS the identity. */
  phone: z.string(),
  businessType: z.string().nullable(),
});
export type BusinessSettingsView = z.infer<typeof businessSettingsView>;

export const businessSettingsResponse = z.object({
  outcome: z.literal('saved'),
  name: z.string(),
  rcNumber: z.string().nullable(),
  tin: z.string().nullable(),
});
export type BusinessSettingsRequest = z.infer<typeof businessSettingsRequest>;
export type BusinessSettingsResponse = z.infer<typeof businessSettingsResponse>;

/**
 * What an operator must say to refund (ADR 0024's matrix).
 *
 * `reason` is one of the published rows rather than free text: a refund
 * policy that is a table and an audit trail that is a sentence somebody typed
 * cannot be reconciled with each other later.
 */
export const opsRefundRequest = z.object({
  businessId: z.string().regex(/^[0-9a-f-]{36}$/i),
  reference: z.string().min(1),
  /** Integer kobo, positive. A zero refund is not a refund. */
  amountK: z.number().int().positive(),
  reason: z.enum([
    'duplicate_charge',
    'incorrect_amount',
    'service_failure',
    'unused_add_on',
    'suspension_error',
  ]),
  /* No `actor`. The audit trail names the VERIFIED operator subject, and a
   * body field here would let whoever held the credential also choose what
   * the record said they were called (ADR 0034). */
});

export type OpsRefundRequest = z.infer<typeof opsRefundRequest>;

/* ── the operator exception queue (MASTER-PLAN §6.4) ─────────────────────── */

/**
 * One event awaiting triage.
 *
 * No payload. Provider bodies are sealed under `VAULT_KEY` and hold the
 * sender's number and their message; a triage list that carried them would be
 * a plaintext feed of every merchant's conversations behind one header. The
 * id, the type and the reason are what triage needs.
 */
export const opsEventView = z.object({
  id: z.string(),
  provider: z.string(),
  eventType: z.string(),
  /** The tenant it reached, when it reached one. An id, never a name. */
  businessId: z.string().nullable(),
  error: z.string().nullable(),
  /** 0 means a signature check failed: an attack, or a rotated key. */
  signatureValid: z.union([z.literal(0), z.literal(1)]),
  createdAt: z.string(),
  /** How long it has been sitting. What an operator judges "stuck" by. */
  ageSeconds: z.number().int().nonnegative(),
  /** The dead payment or billing job behind a flagged event (OWN-73, OWN-76); null otherwise. */
  jobId: z.string().nullable(),
});

/**
 * A payment or billing job that died with no event behind it (OWN-73, OWN-76): its own work item,
 * keyed on the job. Ids, a category and fixed text only; never error text or a payload.
 */
export const opsDeadJobView = z.object({
  jobId: z.string(),
  businessId: z.string(),
  kind: z.enum(['payment.process', 'billing.process']),
  status: z.enum(['open', 'recovering']),
  /** The signed event behind it, when it had one (then it is also that event's flagged row). */
  eventId: z.string().nullable(),
  /** Rekoda's own payment or subscription reference, when the job carried one. */
  reference: z.string().nullable(),
  failureCategory: z.string().nullable(),
  summary: z.string(),
  attempts: z.number().int().nonnegative(),
  deathCount: z.number().int().positive(),
  openedAt: z.string(),
  lastDiedAt: z.string(),
  ageSeconds: z.number().int().nonnegative(),
  /** The charge's (billing) or intent's (payment) status now; null without a reference. */
  paymentState: z.string().nullable(),
  /** The business's plan and paid-to date now, for a billing job; null for a payment job. */
  currentPlan: z.string().nullable(),
  currentPlanExpiresAt: z.string().nullable(),
});

/**
 * A renewal raised while Rekoda cannot take its payment (OWN-70): a live key without the §47
 * confirmation, or no usable key. It stays pending and the grace clock runs (OD-44 open).
 */
export const opsBlockedRenewalView = z.object({
  reference: z.string(),
  businessId: z.string(),
  plan: z.string().nullable(),
  amountK: z.number().int().nonnegative(),
  reason: z.enum(['awaiting_platform_confirmation', 'payments_not_configured']),
  blockedAt: z.string(),
  ageSeconds: z.number().int().nonnegative(),
  currentPlan: z.string(),
  currentRenewsAt: z.string().nullable(),
});

/** Start one verified, bounded recovery of a dead job. The reason is the audit record's. */
export const opsDeadJobRecoverRequest = z.object({
  reason: z.string().trim().min(4).max(200),
});

/**
 * A Rekoda subscription charge that was PAID but not applied (OD-30): the plan
 * change was refused because a newer subscription decision existed. The money
 * is real and the charge stays `paid`; an operator resolves it by the deadline.
 */
export const opsUnappliedChargeView = z.object({
  reference: z.string(),
  businessId: z.string(),
  kind: z.string(),
  /** The plan the payment was meant to buy; null for a pack. */
  plan: z.string().nullable(),
  packId: z.string().nullable(),
  amountK: z.number().int().nonnegative(),
  paidAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  /** Why it was refused, as a code (e.g. `subscription_decided_after_charge`). */
  reason: z.string().nullable(),
  /** The business's plan and renewal date now. */
  currentPlan: z.string(),
  currentPendingPlan: z.string().nullable(),
  currentRenewsAt: z.string().nullable(),
  /** The payable plan charge the merchant has open now: they may be paying twice. */
  openChargeReference: z.string().nullable(),
  /** When the exception was created (the payment settled and was refused). */
  createdAt: z.string(),
  ageSeconds: z.number().int().nonnegative(),
  /** End of the next business day after `createdAt`, Lagos time. */
  resolveBy: z.string(),
  /** Past `resolveBy`: escalate. Never auto-resolved. */
  overdue: z.boolean(),
});

export const opsExceptionsResponse = z.object({
  /** Stored, never processed, never attributed. Oldest first. */
  stuck: z.array(opsEventView),
  /** Flagged with a reason and not yet worked. Oldest first. */
  flagged: z.array(opsEventView),
  /** Paid but unapplied subscription charges awaiting an operator (OD-30). Oldest first. */
  unappliedCharges: z.array(opsUnappliedChargeView),
  /**
   * Dead payment or billing jobs with no event behind them (OWN-73, OWN-76). Oldest first. A dead
   * job WITH an event is that event's flagged row (`jobId`), detailed in `deadJobDetails`.
   */
  deadJobs: z.array(opsDeadJobView),
  /** The detail (reference, current payment and plan state) of each dead job on the flagged list. */
  deadJobDetails: z.array(opsDeadJobView),
  /** Renewals raised while Rekoda could not take the payment (OWN-70), still open. Oldest first. */
  blockedRenewals: z.array(opsBlockedRenewalView),
});

/**
 * Working one exception.
 *
 * A resolution is REQUIRED and is not decoration: the whole point of the
 * queue is that somebody decided, and a row that left the list with nobody's
 * name and no sentence on it is indistinguishable from one that was lost.
 */
/**
 * Erase one email address (OD-39, migration 0191). `ops:privacy`. The address is used to derive its
 * counter key and, when `businessId` is given, compared with that business's billing email; it is
 * never stored, logged or returned. `reason` is closed so no free text can carry the address.
 */
export const opsEmailErasureRequest = z.object({
  address: z.string().trim().min(3).max(320),
  reason: z.enum(['erasure_request', 'limit_cleared']),
  businessId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
});
export type OpsEmailErasureRequest = z.infer<typeof opsEmailErasureRequest>;

export const opsEmailErasureResponse = z.object({
  erased: z.literal(true),
  /** Rows removed from the cross-business confirmation counter; 0 on a repeat. */
  counterRowsRemoved: z.number().int().nonnegative(),
  /**
   * The named business's billing email: `cleared` (it was this address), `different_address`
   * (left as it was), `not_on_file`, or `not_requested` (no business named).
   */
  billingEmail: z.enum(['cleared', 'different_address', 'not_on_file', 'not_requested']),
});
export type OpsEmailErasureResponse = z.infer<typeof opsEmailErasureResponse>;

export const opsResolveEventRequest = z.object({
  resolution: z.string().trim().min(4).max(200),
  /* No `actor`, for the reason on `opsRefundRequest` above. */
});

export type OpsEventView = z.infer<typeof opsEventView>;
export type OpsUnappliedChargeView = z.infer<typeof opsUnappliedChargeView>;
export type OpsExceptionsResponse = z.infer<typeof opsExceptionsResponse>;
export type OpsResolveEventRequest = z.infer<typeof opsResolveEventRequest>;
