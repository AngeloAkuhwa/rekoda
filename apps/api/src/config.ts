/**
 * Environment, validated once at boot.
 *
 * A misconfigured deployment must fail on startup with the name of the missing
 * variable, not at 2am on a merchant's first OTP. Every secret here has a
 * minimum length because a short one is a configuration mistake wearing a
 * valid-looking value.
 */
export interface ApiConfig {
  port: number;
  databaseUrl: string;
  /** Server-side pepper for OTP hashing. Never stored beside the hash. */
  otpPepper: string;
  /** Signs setup grants and session-adjacent artefacts. */
  secret: string;
  /**
   * The header credential for operator endpoints (plan changes, ops health).
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
   * Returns the OTP in the API response. Development and end-to-end tests
   * only — refused outright when NODE_ENV is production, because the failure
   * mode is handing every caller a working credential for any number.
   */
  revealOtp: boolean;
  corsOrigins: string[];
  /** Requests per IP per minute. See the note in main.ts. */
  rateLimitMax: number;
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
   * The self-hosted transcription sidecar (ADR 0005/0008).
   *
   * `.env.example` has documented this since M0 and nothing read it, so voice
   * notes were answered with "text only" no matter what was deployed. Null
   * means no transcriber, and a voice note gets an honest sentence rather
   * than being sent somewhere the privacy page does not mention. WHERE this
   * points is the promise: "audio never leaves Rekoda" is true exactly while
   * it names our own machine.
   */
  sttUrl: string | null;
  /** Daily ceilings. The thing on the other side of these is a bill. */
  aiCallsPerBusinessPerDay: number;
  aiCallsGlobalPerDay: number;
  /**
   * The longest voice note Rekoda will transcribe, in seconds
   * (docs/rekoda-chat-v1.md §2). Configuration, never application logic:
   * the commercial limit varies by plan, environment and future pricing,
   * and an over-length note gets a natural reply, not a silent failure.
   * Consumed by the voice slice; declared now so it cannot be hard-coded.
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
  /** Recorded on every usage row, so a past cost is never re-derived. */
  planningFxNairaPerUsd: number;
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
   * USD micros per in-window service reply. Zero today — Meta does not charge
   * for them yet — and chargeable from 1 October 2026, at which point this is
   * the one number that needs changing.
   */
  metaServiceReplyCostMicros: number;
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
   * Haiku reads the merchant's sentence, not Sonnet.
   *
   * The interpreter's job is one extraction from one short message, under
   * forced tool use against a strict schema, with the arithmetic done
   * afterwards by code that does not trust the answer. That is what the small
   * model is for, and it costs a third of Sonnet's input and output. At the
   * volumes in pricing-model.md the difference is the gap between the model
   * eating a third of a subscription and eating a rounding error.
   *
   * Escalation stays on Opus for the messages that genuinely need it.
   */
  anthropic: 'claude-haiku-4-5',
  openai: null,
};

/**
 * Role defaults (docs/ai-model-strategy.md §1). Every AI call belongs to a
 * ROLE, and each role has its own model — nothing anywhere says "call
 * Sonnet", it says "call the classifier". The reasoning roles default to the
 * Claude family (vision + native PDF + strict tools is where extraction
 * lives); the transcriber defaults to the SELF-HOSTED AfriSpeech-tuned
 * Whisper sidecar (ADR 0005/0008) — "audio never leaves Rekoda" is a trust
 * claim, and generic hosted models mishear African-accented English badly.
 * A hosted transcriber id here is for the M3 benchmark comparator only.
 */
const ROLE_DEFAULTS = {
  classifier: 'claude-haiku-4-5',
  /* Vision keeps the bigger model: reading a photographed receipt is a
   * harder job than parsing a sentence somebody typed, and it is rare. */
  vision: 'claude-sonnet-5',
  escalation: 'claude-opus-5',
  transcriber: 'afrispeech-whisper-medium-all',
} as const;

/**
 * The operator credential, held to the same 32 characters as every other
 * secret here. Optional outside production so a developer is not blocked by
 * a key they do not need; when it is absent the endpoints answer 403, which
 * is the correct behaviour for a gate with no key rather than a reason to
 * open a different one.
 */
function operatorSecret(env: NodeJS.ProcessEnv, isProduction: boolean): string | null {
  const value = env['REKODA_OPERATOR_SECRET'];
  if (!value) {
    if (isProduction) {
      throw new ConfigError('REKODA_OPERATOR_SECRET is required in production');
    }
    return null;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProduction = env['NODE_ENV'] === 'production';

  const revealOtp = env['REKODA_REVEAL_OTP'] === '1';
  if (revealOtp && isProduction) {
    throw new ConfigError(
      'REKODA_REVEAL_OTP must never be set in production — it returns live OTP codes to any caller',
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
    port: Number(env['PORT'] ?? 3001),
    databaseUrl: required(env, 'DATABASE_URL'),
    otpPepper: required(env, 'OTP_PEPPER', 32),
    secret: required(env, 'REKODA_API_SECRET', 32),
    operatorSecret: operatorSecret(env, isProduction),
    revealOtp,
    /**
     * Both required everywhere, not just in production. A deployment without
     * them cannot store a customer identity or read an inbound message, so
     * "optional in development" would only mean discovering that at the first
     * real message instead of at boot. 64 hex characters = 32 bytes, which is
     * what `openssl rand -hex 32` produces and what AES-256 needs.
     */
    vaultKey: required(env, 'VAULT_KEY', 64),
    matchKey: required(env, 'MATCH_KEY', 64),
    corsOrigins: (env['REKODA_CORS_ORIGINS'] ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Raised by the integration suite, which legitimately makes a few hundred
    // requests from one address in well under a minute.
    rateLimitMax: Number(env['REKODA_RATE_LIMIT_MAX'] ?? 60),
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
    aiBaseUrl: env['AI_BASE_URL'] || null,
    aiModelPrices: env['AI_MODEL_PRICES'] || null,
    sttUrl: env['STT_URL'] || null,
    /**
     * Defaults are a ceiling, not a target. At ~₦8 a call (pricing-model.md),
     * 60 per merchant is about ₦480 a day against a subscription, and 5,000
     * platform-wide bounds the worst day this product can have to roughly
     * ₦40,000 — a number that can be absorbed while someone investigates,
     * rather than discovered on an invoice.
     */
    aiCallsPerBusinessPerDay: Number(env['AI_DAILY_CALLS_PER_BUSINESS'] ?? 60),
    aiCallsGlobalPerDay: Number(env['AI_DAILY_CALLS_GLOBAL'] ?? 5_000),
    voiceNoteMaxDurationSeconds: Number(env['VOICE_NOTE_MAX_DURATION_SECONDS'] ?? 120),
    aiDualExtractThresholdK: Number(env['AI_DUAL_EXTRACT_THRESHOLD_K'] ?? 50_000_000),
    aiDocExtractionsPerBusinessPerDay: Number(env['AI_DOC_EXTRACTIONS_PER_BUSINESS'] ?? 25),
    planningFxNairaPerUsd: Number(env['PLANNING_FX_NGN_PER_USD'] ?? 1_450),
    paystackSecretKey: env['PAYSTACK_SECRET_KEY'] ?? '',
    paystackBaseUrl: env['PAYSTACK_BASE_URL'] ?? 'https://api.paystack.co',
    paystackPlatformConfirmed: env['REKODA_PAYSTACK_PLATFORM_CONFIRMED'] === '1',
    connectionKey: env['CONNECTION_KEY'] ?? '',
    metaAccessToken: env['META_ACCESS_TOKEN'] ?? '',
    metaPhoneNumberId: env['META_PHONE_NUMBER_ID'] ?? '',
    metaGraphVersion: env['META_GRAPH_VERSION'] ?? 'v21.0',
    metaOtpTemplate: env['META_OTP_TEMPLATE'] || null,
    metaOtpTemplateLocale: env['META_OTP_TEMPLATE_LOCALE'] ?? 'en',
    metaServiceReplyCostMicros: Number(env['META_SERVICE_REPLY_COST_MICROS'] ?? 0),
    r2AccountId: env['R2_ACCOUNT_ID'] ?? '',
    r2AccessKeyId: env['R2_ACCESS_KEY_ID'] ?? '',
    r2SecretAccessKey: env['R2_SECRET_ACCESS_KEY'] ?? '',
    r2Bucket: env['R2_BUCKET'] ?? '',
    localStorageRoot: env['REKODA_LOCAL_STORAGE'] ?? '',
  };
}

export const CONFIG = Symbol('ApiConfig');
