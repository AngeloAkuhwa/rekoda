/**
 * Environment, validated once at boot.
 *
 * A misconfigured deployment must fail on startup with the name of the missing
 * variable, not at 2am on a merchant's first OTP. Every secret here has a
 * minimum length because a short one is a configuration mistake wearing a
 * valid-looking value.
 */
import type { OperatorAuthConfig } from './auth/operator-identity.js';

export interface ApiConfig {
  port: number;
  databaseUrl: string;
  /** Server-side pepper for OTP hashing. Never stored beside the hash. */
  otpPepper: string;
  /** Signs setup grants and session-adjacent artefacts. */
  secret: string;
  /**
   * The DEVELOPMENT stand-in for operator identity, and only that.
   *
   * A shared header string cannot say WHICH person acted: the audit trail
   * reads the same whoever holds it, and rotating it is the only way to
   * remove anybody. Production verifies `operatorAuth` instead, and refuses
   * to boot if this is set there — a shared secret people believe still
   * works is worse than one that does.
   *
   * DELIBERATELY not `secret`. That one signs setup grants, so reusing it
   * here would mean every proxy access log, shell history and ops runbook
   * that ever saw the header now holds a key that forges those grants: a
   * capability far beyond the endpoint it was typed for.
   *
   * Null when unset, and the endpoints refuse rather than fall back. A gate
   * that silently degrades to a different key is the failure being fixed.
   */
  operatorSecret: string | null;
  /**
   * Where the dashboard lives, for the sign-in link chat sends.
   *
   * Null when unset, and the chat path says so plainly rather than sending a
   * link to nowhere: a merchant who taps one and lands on an error learns
   * that Rekoda's links do not work, and that lesson outlasts the outage.
   */
  webUrl: string | null;
  /**
   * Returns the OTP in the API response. Development and end-to-end tests
   * only — refused outright when NODE_ENV is production, because the failure
   * mode is handing every caller a working credential for any number.
   */
  revealOtp: boolean;
  corsOrigins: string[];
  /** Requests per IP per minute. See the note in main.ts. */
  rateLimitMax: number;
  /**
   * Storefront orders one shop takes per hour before answering `busy`
   * (fix-plan 7, H7b). Counted in the database, so every replica shares one
   * ceiling — unlike the per-IP limiter above. The flood answer, not the
   * capacity one: the monthly plan meter still governs capacity.
   */
  shopOrdersPerHour: number;
  /**
   * Seconds between provider verifies for one Pay-with-Transfer intent
   * (fix-plan 7, H7b). Each status poll used to cost a Paystack call on the
   * merchant's key; the window is claimed in the database so taps beyond the
   * first inside it answer from what is already known.
   */
  transferVerifyMinSeconds: number;
  /** AES-256-GCM key for the identity vault and for sealed event payloads. */
  vaultKey: string;
  /** Keyed HMAC for deterministic identity matching. NOT the vault key. */
  matchKey: string;
  /** Verifies X-Hub-Signature-256 on the Meta webhook. */
  metaAppSecret: string;
  /** Echoed back during Meta's GET subscription handshake. */
  metaVerifyToken: string;
  /**
   * `rekoda_worker` credentials — the only role allowed to claim a job before
   * its tenant is known (migration 0004). Null when this process is not a
   * worker.
   */
  workerDatabaseUrl: string | null;
  /** Whether this process polls the queue as well as serving requests. */
  workerEnabled: boolean;
  /** Concurrent job lanes per worker process. SKIP LOCKED makes N lanes safe. */
  workerConcurrency: number;
  /**
   * A1 rollout flags (spec §25), one per command, default OFF.
   *
   * The flag decides which path an ingress takes to the SAME work function:
   * on, the command bus (entitlement → risk → idempotency → work); off, the
   * work called directly, which is exactly what the ingress did before the
   * command existed. Rollback is a flag flip, per command, with no deploy.
   */
  commandRecordSale: boolean;
  commandIssueInvoice: boolean;
  commandRecordPayment: boolean;
  commandConfirmPayment: boolean;
  commandRecordExpense: boolean;
  commandRecordPurchase: boolean;
  commandPostJournal: boolean;
  commandClosePeriod: boolean;
  commandOpeningBalances: boolean;
  commandPlaceOrder: boolean;
  commandRecordOrder: boolean;
  commandIngestFinancialTransaction: boolean;
  commandConfirmReconciliation: boolean;
  commandAdjustInventory: boolean;
  /* EraseData, VoidReceipt and ReopenAccountingPeriod had flags here and no
   * longer do. Each is HIGH_RISK in `COMMAND_RISK`, so a flag choosing the
   * direct path was configuration deciding whether the confirmation ceremony
   * ran. There is no legitimate rollback to a path that skips it, so the
   * seam is gone rather than merely defaulted on. `commandAdjustInventory`
   * stays because it still governs ordinary ADDITIVE stock work; the
   * destructive half crosses the bus regardless of it. */
  /**
   * Which provider interprets a merchant's message.
   *
   * Not a failover pair: extraction quality IS the product experience
   * (ADR 0007), so which model reads a sentence about money is a decision
   * someone makes, not one a network blip makes for them.
   */
  aiProvider: 'anthropic' | 'openai';
  /** Empty means "behave as if the provider is down" — see ai.module.ts. */
  anthropicApiKey: string;
  openaiApiKey: string;
  aiModelDefault: string;
  /**
   * Per-role model selection (docs/ai-model-strategy.md). The interpreter
   * uses aiModelDefault (unchanged); these name the rest of the ensemble.
   * `classifier` and `vision` land with the document slice, `transcriber`
   * with the voice slice, `escalation` behind a confidence gate — declared
   * now so no call site can ever hard-code a model name.
   */
  aiModelClassifier: string;
  aiModelVision: string;
  aiModelEscalation: string;
  aiModelTranscriber: string;
  /**
   * The independent second reader for documents at or above
   * `AI_DUAL_EXTRACT_THRESHOLD_K` (item 9 of the AI hardening plan). Null
   * disables dual extraction: there is no default because the verifier
   * must come from a DIFFERENT provider than the primary reader, and this
   * repository will not guess a second vendor's model id or price. Set it
   * together with an OPENAI_API_KEY and an AI_MODEL_PRICES entry for its
   * family, or boot refuses.
   */
  aiModelVisionVerifier: string | null;
  /**
   * An OpenAI-COMPATIBLE endpoint, when it is not OpenAI's own.
   *
   * Groq, Together, OpenRouter and DeepSeek weights on a US host all speak
   * the same wire format, so switching to one is a deployment decision rather
   * than a new adapter. Null means the SDK's own default.
   *
   * Which host matters. DeepSeek's own API is PRC-hosted and trains on inputs
   * by default, which is not something a merchant's sentence about their
   * customer can be donated to under the NDPA; the same weights behind a data
   * processing agreement are fine. The URL is a compliance decision.
   */
  aiBaseUrl: string | null;
  /**
   * Model prices as JSON, micro-USD per million tokens, keyed by family.
   *
   * Prices for anything outside the Claude families in `@rekoda/core` live
   * with whoever holds the invoice rather than in this repository, where they
   * would go stale silently. See apps/api/src/ai/model-prices.ts.
   */
  aiModelPrices: string | null;
  /**
   * Per-minute prices for hosted transcription models, as JSON keyed by
   * exact model id:
   *
   *   AI_TRANSCRIPTION_PRICES='{"whisper-1":{"perMinuteMicros":6000}}'
   *
   * Required whenever voice transcription is enabled — boot refuses
   * otherwise, for the same reason token roles must be priced: a
   * transcriber with no price is a transcriber whose every call reports
   * as free.
   */
  aiTranscriptionPrices: string | null;
  /**
   * Whether voice notes are transcribed at all (ADR 0032, remediation R3).
   *
   * The launch transcriber is OpenAI, explicitly and only: there is no
   * self-hosted sidecar in the launch architecture and no fallback between
   * engines. Enabled without OPENAI_API_KEY, boot REFUSES — a deployment
   * that promises voice and cannot deliver it should fail in front of the
   * operator, not in front of a merchant. Disabled (the default), voice
   * notes get an honest sentence and no OpenAI credential needs to exist.
   */
  voiceTranscriptionEnabled: boolean;
  /**
   * Whether photographed documents are read at all (ADR 0032, R3).
   *
   * The launch reader is Anthropic Claude vision as a transcription-only
   * processor. Enabled without ANTHROPIC_API_KEY, boot refuses; disabled
   * (the default), a photograph is answered honestly and goes nowhere.
   * The REASONING model still only ever sees tokenised text either way,
   * and a request that cannot reach the configured engine is refused,
   * never rerouted.
   */
  imageAiEnabled: boolean;
  /** Daily ceilings. The thing on the other side of these is a bill. */
  aiCallsPerBusinessPerDay: number;
  aiCallsGlobalPerDay: number;
  /**
   * The PLATFORM's document-reading day (remediation A4): the backstop
   * behind the per-business ceiling, so a thousand tenants at their own
   * limits still cannot make one day cost more than this many reads.
   */
  aiDocExtractionsGlobalPerDay: number;
  /**
   * Hard daily transcription ceilings, in SECONDS (remediation A4).
   * Operational brakes, distinct from the monthly voice allowance the
   * merchant bought: the monthly meter is commercial, these bound what a
   * single runaway day can cost, per business and platform-wide.
   */
  voiceSecondsPerBusinessPerDay: number;
  voiceSecondsGlobalPerDay: number;
  /**
   * The longest voice note Rekoda will transcribe, in seconds
   * (docs/rekoda-chat-v1.md §2). Configuration, never application logic:
   * the commercial limit varies by plan, environment and future pricing.
   *
   * A REJECTION limit, enforced before any transcription provider is called.
   * The webhook does not carry a duration and the media endpoint does not
   * either, but the bytes are downloaded before anything is spent and the
   * container says how long it is: `AudioMetadataProbe` reads it. A note past
   * this never reaches a provider, which is what makes the number cost
   * protection rather than cost reporting.
   */
  voiceNoteMaxDurationSeconds: number;
  /**
   * Invoices at or above this many KOBO get dual-extracted by two different
   * models, with disagreement routed to requires_review
   * (docs/ai-model-strategy.md §6). Configuration, never a literal at a call
   * site — the threshold is a commercial risk decision. Default ₦500,000.
   */
  aiDualExtractThresholdK: number;
  /**
   * Daily ceiling on AI document-understanding calls per business (uploaded
   * receipts, invoices, statements — rekoda-chat-v1 §4–7). This cost class
   * did not exist when the pricing model was researched (16 Aug) and has no
   * plan unit yet; until it is priced, this ceiling is what stops a heavy
   * uploader from quietly eating a plan's margin. Same shape as the message
   * ceilings: the merchant is told plainly, never cut off mid-transaction.
   */
  aiDocExtractionsPerBusinessPerDay: number;
  /**
   * Turns Rekoda's own USD provider costs into the naira figure written to
   * cost telemetry. Cost-model FX (canonical spec §16) and nothing else: a
   * merchant's books never see it, and it is not an accounting rate.
   *
   * NOT stored on the rows it produces. `usage_events` carries
   * `provider_cost_micros`, `cost_currency` and `naira_equivalent_k`, and no
   * rate column; what is frozen is the RESULT, computed at write time, so a
   * past cost is never re-derived when this constant is next changed.
   */
  planningFxNairaPerUsd: number;
  /**
   * How much of the multicurrency capability this deployment may reach.
   *
   * Rekoda's launch is NGN-only (ADR 0033). The FX capability is being
   * BUILT, in the open, against a schema that already carries immutable rate
   * snapshots and the §16 currency invariants — and no merchant, customer,
   * public API consumer, Chat flow or storefront route may reach it until a
   * separate graduation decision says so.
   *
   * `off` is the default and the only setting production accepts today.
   * Darkness is a mode rather than a missing menu item because a menu item is
   * removed by a page and restored by a page, and this has to be removable by
   * neither.
   */
  fxMode: FxMode;
  /**
   * How an operator proves who they are (P0-2).
   *
   * `null` means no verifier is configured. In production that is a state
   * `loadConfig` refuses to reach, so a null here is a development or test
   * process where the legacy static secret still stands in.
   */
  operatorAuth: OperatorAuthConfig | null;
  /**
   * Signs Paystack webhooks AND authenticates Paystack API calls — Paystack
   * uses the secret key for both. Empty means every webhook is rejected (the
   * safe direction) and no provider call can be made. Deliberately NOT
   * required in production yet: payments do not go live until the §47
   * platform-model confirmation from Paystack is in writing
   * (docs/payments-v1.md), and requiring the key now would block every
   * non-payment deploy on a credential nobody has.
   */
  paystackSecretKey: string;
  /** Overridden only by tests and sandboxes; production uses the default. */
  paystackBaseUrl: string;
  /**
   * §47 in code (docs/payments-v1.md): auto-onboarding merchants as
   * subaccounts under a LIVE key is forbidden until Paystack's written
   * platform-model confirmation exists. Setting this true is the owner
   * recording that the confirmation is in hand. Test keys (sandbox-first,
   * §36) never need it.
   */
  paystackPlatformConfirmed: boolean;
  /**
   * Authenticates bank-feed calls to Mono (ADR 0012, fix-plan 4 G5). Empty
   * means the feed door does not exist on this deployment: the bank page
   * says so and the CSV upload carries reconciliation alone, which is how
   * every deployment ran before the feed shipped. Same posture as the
   * Paystack key: optional at boot, refused plainly at call time.
   */
  monoSecretKey: string;
  /** Overridden only by tests and sandboxes; production uses the default. */
  monoBaseUrl: string;
  /**
   * Encrypts merchant settlement details (the full account number) at rest.
   * Deliberately NOT the vault key: customer identities and merchant banking
   * credentials are different blast radii, and holding one must not imply
   * holding the other. Optional at boot — connection onboarding refuses
   * plainly at call time when it is missing, and nothing else needs it.
   */
  connectionKey: string;
  /** Sends replies. Empty means replies are recorded but not delivered. */
  metaAccessToken: string;
  metaPhoneNumberId: string;
  metaGraphVersion: string;
  /**
   * The Meta-approved AUTHENTICATION template that carries a sign-in code.
   *
   * Null means sign-in cannot deliver anything, which is the honest state
   * before a WABA has an approved template: a free-form text to a phone that
   * has never messaged the business number is rejected by Meta, so there is
   * no working fallback to quietly take instead.
   */
  metaOtpTemplate: string | null;
  metaOtpTemplateLocale: string;
  /**
   * The Meta-approved UTILITY template that carries a grace reminder.
   *
   * Null means the grace sweep records reminders and delivers none, which is
   * the honest state before the template is approved. The dashboard still
   * shows the merchant where they stand; a free-form text to a phone that has
   * not messaged the business number in days would simply be rejected.
   */
  metaBillingTemplate: string | null;
  metaBillingTemplateLocale: string;
  /**
   * The Meta-approved UTILITY template that warns about deletion.
   *
   * Null means the retention sweep warns nobody and therefore deletes
   * nothing: a schedule that promises notice cannot delete an account it
   * failed to notify, so the absence of a template stops the sweep rather
   * than being routed around.
   */
  metaRetentionTemplate: string | null;
  metaRetentionTemplateLocale: string;
  /**
   * USD micros per in-window service reply. Zero today — Meta does not charge
   * for them yet — and chargeable from 1 October 2026, at which point this is
   * the one number that needs changing.
   */
  metaServiceReplyCostMicros: number;
  /**
   * Where Rekoda's own WABA is registered, which decides the authentication
   * rate every sign-in code is billed at.
   *
   * A Nigeria-registered WABA pays $0.0145 per authentication conversation
   * and one registered anywhere else pays $0.0750 for the identical message
   * (docs/pricing-model.md). That is over five times the cost of the single
   * most expensive message Rekoda sends, on the busiest path it has, and the
   * same document carries it as a launch requirement.
   *
   * Defaults to true because that is the launch requirement, not because it
   * is the safe direction: a deployment that moved the WABA and did not set
   * this would under-report its own OTP bill by a factor of five, so the
   * default is the state the business is required to be in and the flag is
   * how an operator admits it is not.
   */
  metaWabaRegisteredInNigeria: boolean;
  /**
   * BL2 cutover flag (spec §30, build plan §10 step D): on, commercial terms
   * (allowances, seats, prices) read from the plan catalogue through the
   * grandfathering pin; off, the pre-BL2 constants in `@rekoda/core`.
   *
   * Defaults ON because the cutover is the required state - the constants
   * are the DRIFTED shape §30 names - and rollback is this one variable set
   * to `0`, no deploy. The old path is deleted only after the catalogue has
   * soaked (step E, with the add-ons slice).
   */
  planCatalogueReads: boolean;
  /** R2. All four empty means documents are rendered but not stored. */
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  /**
   * Filesystem fallback for development. Never used when R2 is configured —
   * a deployment that quietly wrote a merchant's invoices to a container's
   * local disk would lose them on the next restart.
   */
  localStorageRoot: string;
}

class ConfigError extends Error {}

/**
 * A model id is not portable between providers, so the default follows one.
 *
 * EXACT ids, never `-latest` aliases. An alias that silently moves is an
 * unannounced change to the thing that reads a merchant's sentence about
 * money, and it takes the price with it: cost telemetry keys on the family,
 * so an alias hopping tiers reports last month's rate for this month's bill.
 *
 * There is no OpenAI default any more, and that is deliberate. `gpt-4.1`
 * leaves the API on 14 October 2026, and picking its successor here would
 * mean shipping a price this repository cannot verify. `AI_MODEL_DEFAULT` is
 * required when `AI_PROVIDER=openai`, together with a price for it.
 */
const DEFAULT_MODEL: Record<'anthropic' | 'openai', string | null> = {
  /**
   * Sonnet reads the merchant's sentence (ADR 0031, accuracy-first).
   *
   * ADR 0023 put Haiku here on cost grounds, and its reasoning about the
   * SHAPE of the job still holds: one extraction, forced tool use, strict
   * schema, arithmetic recomputed by code that does not trust the answer.
   * What changed is the launch priority and the price. The product optimises
   * for avoiding harmful financial mistakes rather than for answering
   * cheaply, a misread amount that survives the schema is the one error no
   * gate downstream can catch, and Sonnet 5's permanent $2/$10 rate closed
   * most of the gap that justified the small model. Haiku keeps the
   * CLASSIFIER role, where a cheap answer avoids a costlier call and a
   * mistake costs a retry rather than a wrong draft.
   *
   * Escalation stays on Opus for the messages that genuinely need it.
   */
  anthropic: 'claude-sonnet-5',
  openai: null,
};

/**
 * Role defaults (docs/ai-model-strategy.md §1). Every AI call belongs to a
 * ROLE, and each role has its own model — nothing anywhere says "call
 * Sonnet", it says "call the classifier". The reasoning roles default to the
 * Claude family (vision + native PDF + strict tools is where extraction
 * lives). The transcriber defaults to whisper-1 on OpenAI (ADR 0032): the
 * launch architecture is hosted AI end to end with exactly one engine per
 * job, and whisper-1 is the transcription model that reports the audio
 * DURATION, which the voice_seconds meter takes as the provider's number
 * rather than an estimate.
 */
const ROLE_DEFAULTS = {
  classifier: 'claude-haiku-4-5',
  /* Vision keeps the bigger model: reading a photographed receipt is a
   * harder job than parsing a sentence somebody typed, and it is rare. */
  vision: 'claude-sonnet-5',
  escalation: 'claude-opus-5',
  transcriber: 'whisper-1',
} as const;

/**
 * The operator credential, held to the same 32 characters as every other
 * secret here. Optional outside production so a developer is not blocked by
 * a key they do not need; when it is absent the endpoints answer 403, which
 * is the correct behaviour for a gate with no key rather than a reason to
 * open a different one.
 */
/**
 * The dashboard's public origin, with any trailing slash removed so the one
 * place that builds a URL never produces a double slash.
 *
 * Refused unless it is http(s). A link is something a merchant taps, and a
 * scheme somebody typed into an environment variable is not a thing to hand
 * a phone unchecked.
 */
function webUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env['REKODA_WEB_URL']?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * The voice length limit, which now gates a capability rather than merely
 * describing one.
 *
 * A blank or mistyped value used to be harmless; since this is the limit a
 * note is measured against before the transcriber runs, a NaN or a zero would
 * refuse every voice note as too long, which reads to a merchant as the
 * product being broken and to an engineer as a metering bug rather than a
 * typo. Boot is the right place to say so.
 */
function voiceWindowSeconds(env: NodeJS.ProcessEnv): number {
  return positiveInteger(env, 'VOICE_NOTE_MAX_DURATION_SECONDS', 120);
}

/**
 * Every numeric environment value, read one way (`planningFx`'s pattern,
 * generalized - the FX brief fixed this once and the rest of the file kept
 * the bug it fixed). Raw `Number(env[...] ?? d)` has three ways to go wrong
 * and the quietest is the worst: `??` only catches undefined, so `NAME=`
 * with nothing after it is an empty STRING and `Number('')` is 0 - not NaN,
 * not the default. A mistyped value gives NaN, which every comparison
 * answers false to, so an AI cost brake set to `oops` simply stops braking
 * and nothing anywhere says so. None of that is a runtime condition to
 * handle; it is a deployment typo, and boot is where a deployment typo
 * belongs: one-line refusal, naming the variable.
 */
function numericEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  requirement: string,
  accepts: (value: number) => boolean,
): number {
  const raw = env[name];
  /* Absent means the default. Present-but-blank does NOT: somebody wrote the
   * name down and left the value off, which is a question, not a default -
   * and the check must come BEFORE Number(), because `Number('')` is 0,
   * which the non-negative validators would otherwise wave through as a
   * silent kill switch nobody asked for. */
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    throw new ConfigError(`${name} must be ${requirement}`);
  }
  const value = Number(raw);
  if (!accepts(value)) {
    throw new ConfigError(`${name} must be ${requirement}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return numericEnv(
    env,
    name,
    fallback,
    'a positive whole number',
    (v) => Number.isInteger(v) && v > 0,
  );
}

/**
 * Zero is a VALUE here, never unlimited (PR-014's rule): a quota of 0 is a
 * deliberate kill switch, and a verify window of 0 is "verify every poll",
 * which one integration suite sets on purpose.
 */
function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return numericEnv(
    env,
    name,
    fallback,
    'a whole number, zero or more',
    (v) => Number.isInteger(v) && v >= 0,
  );
}

function positiveFiniteNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  requirement: string,
): number {
  return numericEnv(env, name, fallback, requirement, (v) => Number.isFinite(v) && v > 0);
}

function boundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  return numericEnv(
    env,
    name,
    fallback,
    `a whole number between ${min} and ${max}`,
    (v) => Number.isInteger(v) && v >= min && v <= max,
  );
}

/**
 * The planning FX rate, refused at boot rather than carried into arithmetic.
 *
 * `Number(env[...] ?? 1_450)` had three ways to go wrong and the quietest was
 * the worst. `??` only catches undefined, so `PLANNING_FX_NGN_PER_USD=` with
 * nothing after it is an empty STRING, and `Number('')` is 0 - not NaN, not
 * the default. Every AI call would then record a naira cost of zero, the
 * margin report would read as pure profit, and nothing anywhere would say so.
 * A cost telemetry that reports zero is worse than one that reports nothing,
 * because somebody believes it.
 *
 * The louder failures are still failures in the wrong place. A mistyped value
 * gives NaN, `naira_equivalent_k` is a bigint, and PostgreSQL REFUSES a NaN
 * rather than storing one - so the write fails, inside a job, long after the
 * process started, one cost row at a time. A negative value records negative
 * costs and is accepted all the way down.
 *
 * None of that is a merchant's problem or a runtime condition to handle. It
 * is a deployment typo, and boot is where a deployment typo belongs.
 */
function planningFx(env: NodeJS.ProcessEnv): number {
  return positiveFiniteNumber(
    env,
    'PLANNING_FX_NGN_PER_USD',
    1_450,
    'a positive number of naira per USD',
  );
}

/**
 * The four states of the dark FX capability (ADR 0033).
 *
 * ```
 * off      no provider call, no executable quote, no FX anything.
 * shadow   rates may be OBSERVED for engineering evaluation. No execution.
 * sandbox  a provider's SANDBOX API only, for integration tests.
 * live     the state the graduation gate opens. Not reachable yet.
 * ```
 *
 * The ordering is deliberate and it is not a scale of convenience: each step
 * adds one capability that the step before it could not perform at all.
 */
export const FX_MODES = ['off', 'shadow', 'sandbox', 'live'] as const;
export type FxMode = (typeof FX_MODES)[number];

/**
 * `live` needs more than one environment variable, and today it needs a
 * decision nobody has made.
 *
 * A kill switch that one typo can flip is a promise, not a control. So
 * production refuses to START on `FX_MODE=live` while the capability is dark:
 * not "ignores it", not "warns and continues", but fails to boot, because a
 * process that came up with live FX believing it was configured to is exactly
 * the accident this exists to prevent. When the FX graduation gate is
 * complete, `live` will additionally require a named approval token and a
 * provider capability record; the refusal below is replaced then, by the PR
 * that opens the gate, and never by an environment change.
 */
function fxMode(env: NodeJS.ProcessEnv, isProduction: boolean): FxMode {
  const raw = env['FX_MODE'] ?? 'off';
  if (!(FX_MODES as readonly string[]).includes(raw)) {
    throw new ConfigError(`FX_MODE must be one of ${FX_MODES.join(', ')}`);
  }
  const mode = raw as FxMode;
  if (mode === 'live' && isProduction) {
    throw new ConfigError(
      'FX live execution has not been graduated: the multicurrency capability is dark ' +
        '(ADR 0033), and FX_MODE=live is refused in production until the FX graduation ' +
        'gate is complete',
    );
  }
  return mode;
}

/**
 * The operator plane's identity provider, or a refusal to run without one.
 *
 * Provider-neutral on purpose: issuer, audience and key set are deployment
 * facts, so Cloudflare Access, an IAP or a plain OIDC provider all satisfy
 * this and none of them is named in the code.
 *
 * Production requires all three or REFUSES TO BOOT. That is the fail-closed
 * half of the rule and it is not a runtime 503: a process that started
 * without operator identity is a process where somebody will reach for the
 * static secret during an incident, and an incident is exactly when
 * estate-wide authority should be hardest to get. Outside production the
 * absence is ordinary, and the legacy secret covers local work.
 *
 * Partial configuration is refused everywhere, production or not. Two of
 * three is somebody halfway through a deployment change, and silently
 * treating that as "no verifier" would turn a half-finished rollout into a
 * quiet downgrade to the shared secret.
 */
function operatorAuth(env: NodeJS.ProcessEnv, isProduction: boolean): OperatorAuthConfig | null {
  const issuer = env['OPERATOR_OIDC_ISSUER'];
  const audience = env['OPERATOR_OIDC_AUDIENCE'];
  const jwksUrl = env['OPERATOR_OIDC_JWKS_URL'];
  const present = [issuer, audience, jwksUrl].filter(Boolean).length;

  if (present === 0) {
    if (isProduction) {
      throw new ConfigError(
        'the operator plane needs a verified identity in production: set ' +
          'OPERATOR_OIDC_ISSUER, OPERATOR_OIDC_AUDIENCE and OPERATOR_OIDC_JWKS_URL. ' +
          'REKODA_OPERATOR_SECRET is a development stand-in and is never a production fallback',
      );
    }
    return null;
  }
  if (present < 3) {
    throw new ConfigError(
      'operator identity needs all of OPERATOR_OIDC_ISSUER, OPERATOR_OIDC_AUDIENCE and ' +
        'OPERATOR_OIDC_JWKS_URL, or none of them',
    );
  }
  for (const [name, value] of [
    ['OPERATOR_OIDC_ISSUER', issuer],
    ['OPERATOR_OIDC_JWKS_URL', jwksUrl],
  ] as const) {
    if (!/^https:\/\//.test(value!)) {
      throw new ConfigError(`${name} must be an https URL`);
    }
  }
  return {
    issuer: issuer!,
    audience: audience!,
    jwksUrl: jwksUrl!,
    /* OIDC's own claim, overridable because providers disagree about it. */
    scopeClaim: env['OPERATOR_OIDC_SCOPE_CLAIM'] ?? 'scope',
  };
}

function operatorSecret(env: NodeJS.ProcessEnv, isProduction: boolean): string | null {
  const value = env['REKODA_OPERATOR_SECRET'];
  if (!value) return null;
  /* Set, in production, where it can no longer authorise anything. Refused
   * rather than ignored: a secret sitting in a production environment reads
   * as a live credential to everyone who finds it, and the one thing worse
   * than a shared secret is a shared secret people believe still works. */
  if (isProduction) {
    throw new ConfigError(
      'REKODA_OPERATOR_SECRET is a development stand-in and must not be set in production; ' +
        'the operator plane uses OPERATOR_OIDC_* there',
    );
  }
  if (value.length < 32) {
    throw new ConfigError('REKODA_OPERATOR_SECRET must be at least 32 characters');
  }
  if (value === env['REKODA_API_SECRET']) {
    throw new ConfigError('REKODA_OPERATOR_SECRET must differ from REKODA_API_SECRET');
  }
  return value;
}

/**
 * The interpreter's model, or a refusal to guess one.
 *
 * A provider with no default here is not an oversight: it means nobody has
 * checked which of its models this product should use or what that model
 * costs, and both are decisions with a bill attached.
 */
function modelDefault(env: NodeJS.ProcessEnv, provider: 'anthropic' | 'openai'): string {
  const configured = env['AI_MODEL_DEFAULT'];
  if (configured) return configured;
  const fallback = DEFAULT_MODEL[provider];
  if (!fallback) {
    throw new ConfigError(
      `AI_PROVIDER=${provider} requires AI_MODEL_DEFAULT (no default ships for it) ` +
        'and a price for that model in AI_MODEL_PRICES',
    );
  }
  return fallback;
}

function required(env: NodeJS.ProcessEnv, key: string, minLength = 0): string {
  const value = env[key];
  if (!value) throw new ConfigError(`${key} is required`);
  if (value.length < minLength) {
    throw new ConfigError(`${key} must be at least ${minLength} characters`);
  }
  return value;
}

/**
 * A 32-byte AES key, as 64 hex characters. Validating the SHAPE at boot, not
 * just the length, is the difference between a misconfiguration caught by an
 * operator at startup and one discovered by a merchant at a money path: a
 * 64-character passphrase clears a length check, boots clean, and then
 * throws `VaultError` from the vault's own `^[0-9a-f]{64}$` gate at the first
 * encrypt - which is exactly the vault key's contract, enforced one layer
 * too late to be a configuration error.
 */
function requiredHexKey(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key, 64);
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new ConfigError(`${key} must be 64 hex characters (openssl rand -hex 32)`);
  }
  return value;
}

/**
 * An OPTIONAL hex key: empty means the capability it protects is off (the
 * call sites all guard on truthiness), but a NON-empty value must be a real
 * key. `CONNECTION_KEY` guards the highest-value secrets in the estate -
 * merchants' Paystack keys, WABA tokens, settlement account numbers - and a
 * `changeme` there previously booted clean and failed at onboarding.
 */
function optionalHexKey(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) return '';
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new ConfigError(`${key}, when set, must be 64 hex characters (openssl rand -hex 32)`);
  }
  return value;
}

/**
 * Whether to apply production hardening - and it FAILS CLOSED.
 *
 * The old test was `NODE_ENV === 'production'`, which meant `NODE_ENV=prod`,
 * `Production`, `staging`, or any typo skipped every production requirement:
 * the trusted-proxy rule that stops a forged X-Forwarded-For, the ban on
 * returning live OTP codes, the required Meta secrets. Hardening now applies
 * UNLESS the environment is explicitly one of the known non-production
 * values, so an unrecognised NODE_ENV is treated as production rather than
 * as development. Unset is development (tests and local dev delete it), which
 * is the one non-production state that carries no name.
 */
const NON_PRODUCTION_ENVS = new Set(['development', 'test']);
export function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env['NODE_ENV'];
  if (value === undefined || value === '') return false;
  return !NON_PRODUCTION_ENVS.has(value);
}

/** Boolean env flags accept the repo's `1` convention and plain `true`. */
function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProduction = isProductionEnv(env);

  const revealOtp = env['REKODA_REVEAL_OTP'] === '1';
  if (revealOtp && isProduction) {
    throw new ConfigError(
      'REKODA_REVEAL_OTP must never be set in production — it returns live OTP codes to any caller',
    );
  }

  /**
   * A media feature switched ON with no provider to serve it is a promise
   * the deployment cannot keep (ADR 0032, remediation R3): the failure
   * belongs in front of the operator at startup, not in front of a merchant
   * mid-message. Disabled features need no credentials at all.
   */
  if (flag(env['VOICE_TRANSCRIPTION_ENABLED']) && !env['OPENAI_API_KEY']) {
    throw new ConfigError(
      'VOICE_TRANSCRIPTION_ENABLED is set but OPENAI_API_KEY is not. The launch transcriber ' +
        'is OpenAI, explicitly: supply the key, or disable voice transcription.',
    );
  }
  if (flag(env['IMAGE_AI_ENABLED']) && !env['ANTHROPIC_API_KEY']) {
    throw new ConfigError(
      'IMAGE_AI_ENABLED is set but ANTHROPIC_API_KEY is not. The launch document reader ' +
        'is Anthropic Claude vision, explicitly: supply the key, or disable image AI.',
    );
  }

  /**
   * Explicit choice wins. With no choice made, whichever key is present is
   * used — and if BOTH are present, Anthropic, because ADR 0007 names Sonnet
   * the default brain and a coin toss is not a routing policy.
   */
  const requested = env['AI_PROVIDER'];
  if (requested && requested !== 'anthropic' && requested !== 'openai') {
    throw new ConfigError(`AI_PROVIDER must be "anthropic" or "openai", not "${requested}"`);
  }
  const aiProvider: 'anthropic' | 'openai' =
    requested === 'openai' || requested === 'anthropic'
      ? requested
      : env['ANTHROPIC_API_KEY']
        ? 'anthropic'
        : env['OPENAI_API_KEY']
          ? 'openai'
          : 'anthropic';

  if (requested === 'anthropic' && !env['ANTHROPIC_API_KEY']) {
    throw new ConfigError('AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
  }
  if (requested === 'openai' && !env['OPENAI_API_KEY']) {
    throw new ConfigError('AI_PROVIDER=openai but OPENAI_API_KEY is not set');
  }

  /* A deployment that can send WhatsApp but has no approved authentication
   * template can take sign-ups and deliver no sign-in codes, and the failure
   * is invisible: the API answers "sent" by design, so nobody can distinguish
   * it from a phone that simply has no WhatsApp. Caught at boot instead. */
  if (isProduction && env['META_ACCESS_TOKEN'] && !env['META_OTP_TEMPLATE']) {
    throw new ConfigError(
      'META_ACCESS_TOKEN is set but META_OTP_TEMPLATE is not: sign-in codes cannot be delivered',
    );
  }

  const workerEnabled = env['REKODA_WORKER'] === '1';
  if (workerEnabled && !env['WORKER_DATABASE_URL']) {
    throw new ConfigError('REKODA_WORKER=1 requires WORKER_DATABASE_URL (the rekoda_worker role)');
  }

  return {
    port: boundedInteger(env, 'PORT', 3001, 1, 65535),
    databaseUrl: required(env, 'DATABASE_URL'),
    otpPepper: required(env, 'OTP_PEPPER', 32),
    secret: required(env, 'REKODA_API_SECRET', 32),
    operatorSecret: operatorSecret(env, isProduction),
    webUrl: webUrl(env),
    revealOtp,
    /**
     * Both required everywhere, not just in production. A deployment without
     * them cannot store a customer identity or read an inbound message, so
     * "optional in development" would only mean discovering that at the first
     * real message instead of at boot. 64 hex characters = 32 bytes, which is
     * what `openssl rand -hex 32` produces and what AES-256 needs.
     */
    vaultKey: requiredHexKey(env, 'VAULT_KEY'),
    matchKey: requiredHexKey(env, 'MATCH_KEY'),
    corsOrigins: (env['REKODA_CORS_ORIGINS'] ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Raised by the integration suite, which legitimately makes a few hundred
    // requests from one address in well under a minute.
    rateLimitMax: positiveInteger(env, 'REKODA_RATE_LIMIT_MAX', 60),
    /* Two orders a minute, sustained for an hour, from ONE shop page is a
     * very good day for a small merchant; a flood is something else. */
    shopOrdersPerHour: positiveInteger(env, 'REKODA_SHOP_ORDERS_PER_HOUR', 120),
    transferVerifyMinSeconds: nonNegativeInteger(env, 'REKODA_TRANSFER_VERIFY_MIN_SECONDS', 5),
    /**
     * Required in production, optional elsewhere. An empty secret makes
     * `verifyMetaSignature` return false for everything, so a misconfigured
     * deployment rejects webhooks rather than accepting unsigned ones — the
     * safe direction to fail.
     */
    metaAppSecret: isProduction
      ? required(env, 'META_APP_SECRET', 16)
      : (env['META_APP_SECRET'] ?? ''),
    metaVerifyToken: isProduction
      ? required(env, 'META_VERIFY_TOKEN', 16)
      : (env['META_VERIFY_TOKEN'] ?? ''),
    /**
     * No fallback to DATABASE_URL. The obvious convenience —
     * "use the app connection if no worker one is set" — would hand the runner
     * a role with no cross-tenant claim policy, so the queue would appear
     * permanently empty and jobs would pile up silently. Worse, in an
     * environment where DATABASE_URL happens to be the owner, it would hand
     * the runner BYPASSRLS. Absent means absent.
     */
    workerDatabaseUrl: env['WORKER_DATABASE_URL'] ?? null,
    workerEnabled,
    /**
     * Four lanes by default: enough that one slow model call does not stall
     * every document delivery behind it, and comfortably inside the worker
     * connection pool since each in-flight job holds a claim connection and
     * a handler transaction. Raise it with the pool, not instead of it.
     */
    /* The old `Math.max(1, Number(...))` was a floor that could not hold:
     * `Math.max(1, NaN)` is NaN. */
    workerConcurrency: positiveInteger(env, 'REKODA_WORKER_CONCURRENCY', 4),
    commandRecordSale: env['REKODA_COMMAND_RECORD_SALE'] === '1',
    commandIssueInvoice: env['REKODA_COMMAND_ISSUE_INVOICE'] === '1',
    commandRecordPayment: env['REKODA_COMMAND_RECORD_PAYMENT'] === '1',
    commandConfirmPayment: env['REKODA_COMMAND_CONFIRM_PAYMENT'] === '1',
    commandRecordExpense: env['REKODA_COMMAND_RECORD_EXPENSE'] === '1',
    commandRecordPurchase: env['REKODA_COMMAND_RECORD_PURCHASE'] === '1',
    commandPostJournal: env['REKODA_COMMAND_POST_JOURNAL'] === '1',
    commandClosePeriod: env['REKODA_COMMAND_CLOSE_PERIOD'] === '1',
    commandOpeningBalances: env['REKODA_COMMAND_OPENING_BALANCES'] === '1',
    /**
     * On unless explicitly switched off, which is the opposite sense of its
     * siblings. PlaceOrder finished its rollout: the storefront and the WABA
     * catalogue both run it in production, and leaving the default at off
     * meant an environment that forgot the variable took orders through a
     * path with no entitlement check and no idempotency key. Absent
     * configuration should mean the safe door, not the legacy one.
     */
    commandPlaceOrder: env['REKODA_COMMAND_PLACE_ORDER'] !== '0',
    commandRecordOrder: env['REKODA_COMMAND_RECORD_ORDER'] === '1',
    commandIngestFinancialTransaction: env['REKODA_COMMAND_INGEST_FINANCIAL_TRANSACTION'] === '1',
    commandConfirmReconciliation: env['REKODA_COMMAND_CONFIRM_RECONCILIATION'] === '1',
    commandAdjustInventory: env['REKODA_COMMAND_ADJUST_INVENTORY'] === '1',
    /**
     * Optional. The deterministic router answers most messages
     * without a model, so a missing key degrades the product rather than
     * breaking it — and a developer running the web app to look at a page
     * should not need an Anthropic account.
     */
    anthropicApiKey: env['ANTHROPIC_API_KEY'] ?? '',
    openaiApiKey: env['OPENAI_API_KEY'] ?? '',
    aiProvider,
    /**
     * The default model follows the provider, because a model id is not
     * portable between them — `claude-haiku-4-5` means nothing to OpenAI.
     * Set `AI_MODEL_DEFAULT` to override. Anthropic has a default; anything
     * else must name its model, because this repository will not guess an id
     * whose price it cannot verify (see DEFAULT_MODEL).
     */
    aiModelDefault: modelDefault(env, aiProvider),
    aiModelClassifier: env['AI_MODEL_CLASSIFIER'] ?? ROLE_DEFAULTS.classifier,
    aiModelVision: env['AI_MODEL_VISION'] ?? ROLE_DEFAULTS.vision,
    aiModelEscalation: env['AI_MODEL_ESCALATION'] ?? ROLE_DEFAULTS.escalation,
    aiModelTranscriber: env['AI_MODEL_TRANSCRIBER'] ?? ROLE_DEFAULTS.transcriber,
    aiModelVisionVerifier: env['AI_MODEL_VISION_VERIFIER'] || null,
    aiBaseUrl: env['AI_BASE_URL'] || null,
    aiModelPrices: env['AI_MODEL_PRICES'] || null,
    aiTranscriptionPrices: env['AI_TRANSCRIPTION_PRICES'] || null,
    voiceTranscriptionEnabled: flag(env['VOICE_TRANSCRIPTION_ENABLED']),
    imageAiEnabled: flag(env['IMAGE_AI_ENABLED']),
    /**
     * Defaults are a ceiling, not a target. At ~₦8 a call (pricing-model.md),
     * 60 per merchant is about ₦480 a day against a subscription, and 5,000
     * platform-wide bounds the worst day this product can have to roughly
     * ₦40,000 — a number that can be absorbed while someone investigates,
     * rather than discovered on an invoice.
     */
    aiCallsPerBusinessPerDay: nonNegativeInteger(env, 'AI_DAILY_CALLS_PER_BUSINESS', 60),
    aiCallsGlobalPerDay: nonNegativeInteger(env, 'AI_DAILY_CALLS_GLOBAL', 5_000),
    /* 2,000 reads/day platform-wide is roughly ₦16,000 of vision at the
     * planning rate: absorbable while someone investigates. */
    aiDocExtractionsGlobalPerDay: nonNegativeInteger(env, 'AI_DOC_EXTRACTIONS_GLOBAL', 2_000),
    /* 30 minutes a day per business (the largest plan carries 120/month),
     * 10 hours a day platform-wide (~$3.60 at $0.006/min). Generous for
     * every legitimate day; a wall for a scripted one. */
    voiceSecondsPerBusinessPerDay: nonNegativeInteger(
      env,
      'VOICE_SECONDS_PER_BUSINESS_PER_DAY',
      1_800,
    ),
    voiceSecondsGlobalPerDay: nonNegativeInteger(env, 'VOICE_SECONDS_GLOBAL_PER_DAY', 36_000),
    voiceNoteMaxDurationSeconds: voiceWindowSeconds(env),
    aiDualExtractThresholdK: nonNegativeInteger(env, 'AI_DUAL_EXTRACT_THRESHOLD_K', 50_000_000),
    aiDocExtractionsPerBusinessPerDay: nonNegativeInteger(
      env,
      'AI_DOC_EXTRACTIONS_PER_BUSINESS',
      25,
    ),
    planningFxNairaPerUsd: planningFx(env),
    fxMode: fxMode(env, isProduction),
    operatorAuth: operatorAuth(env, isProduction),
    paystackSecretKey: env['PAYSTACK_SECRET_KEY'] ?? '',
    paystackBaseUrl: env['PAYSTACK_BASE_URL'] ?? 'https://api.paystack.co',
    paystackPlatformConfirmed: env['REKODA_PAYSTACK_PLATFORM_CONFIRMED'] === '1',
    monoSecretKey: env['MONO_SECRET_KEY'] ?? '',
    monoBaseUrl: env['MONO_BASE_URL'] ?? 'https://api.withmono.com',
    connectionKey: optionalHexKey(env, 'CONNECTION_KEY'),
    metaAccessToken: env['META_ACCESS_TOKEN'] ?? '',
    metaPhoneNumberId: env['META_PHONE_NUMBER_ID'] ?? '',
    metaGraphVersion: env['META_GRAPH_VERSION'] ?? 'v21.0',
    metaOtpTemplate: env['META_OTP_TEMPLATE'] || null,
    metaOtpTemplateLocale: env['META_OTP_TEMPLATE_LOCALE'] ?? 'en',
    metaBillingTemplate: env['META_BILLING_TEMPLATE'] || null,
    metaBillingTemplateLocale: env['META_BILLING_TEMPLATE_LOCALE'] ?? 'en',
    metaRetentionTemplate: env['META_RETENTION_TEMPLATE'] || null,
    metaRetentionTemplateLocale: env['META_RETENTION_TEMPLATE_LOCALE'] ?? 'en',
    metaServiceReplyCostMicros: nonNegativeInteger(env, 'META_SERVICE_REPLY_COST_MICROS', 0),
    metaWabaRegisteredInNigeria: env['META_WABA_REGISTERED_IN_NIGERIA'] !== 'false',
    planCatalogueReads: env['REKODA_PLAN_CATALOGUE_READS'] !== '0',
    r2AccountId: env['R2_ACCOUNT_ID'] ?? '',
    r2AccessKeyId: env['R2_ACCESS_KEY_ID'] ?? '',
    r2SecretAccessKey: env['R2_SECRET_ACCESS_KEY'] ?? '',
    r2Bucket: env['R2_BUCKET'] ?? '',
    localStorageRoot: env['REKODA_LOCAL_STORAGE'] ?? '',
  };
}

export const CONFIG = Symbol('ApiConfig');
