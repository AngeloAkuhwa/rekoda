/**
 * Choosing a provider (owner directive, 19 Aug 2026: keep it open to both).
 *
 * The interesting cases are all about ambiguity — no key, both keys, a key
 * that contradicts an explicit choice — because that is where a wrong default
 * silently sends a merchant's money message to a model nobody picked.
 */
import { describe, expect, it } from 'vitest';
import { isProductionEnv, loadConfig } from './config.js';

const BASE = {
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/x',
  OTP_PEPPER: 'p'.repeat(40),
  REKODA_API_SECRET: 's'.repeat(40),
  VAULT_KEY: 'a'.repeat(64),
  MATCH_KEY: 'b'.repeat(64),
} as NodeJS.ProcessEnv;

describe('picking a provider', () => {
  it('follows an explicit choice', () => {
    expect(
      loadConfig({ ...BASE, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', AI_MODEL_DEFAULT: 'm' })
        .aiProvider,
    ).toBe('openai');
    expect(
      loadConfig({ ...BASE, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).aiProvider,
    ).toBe('anthropic');
  });

  it('uses whichever key is present when no choice is made', () => {
    expect(loadConfig({ ...BASE, OPENAI_API_KEY: 'k', AI_MODEL_DEFAULT: 'm' }).aiProvider).toBe(
      'openai',
    );
    expect(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k' }).aiProvider).toBe('anthropic');
  });

  it('prefers Anthropic when BOTH keys are present', () => {
    // ADR 0007 names Sonnet the default brain. A coin toss is not a routing
    // policy, and "whichever we read first" is a coin toss.
    const config = loadConfig({ ...BASE, OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' });
    expect(config.aiProvider).toBe('anthropic');
  });

  it('REFUSES a choice whose key is missing', () => {
    /**
     * The failure this prevents: `AI_PROVIDER=openai` with no OpenAI key
     * silently falling back to Anthropic. The deployment would work, and
     * would be billing an account nobody meant to use.
     */
    expect(() => loadConfig({ ...BASE, AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(() => loadConfig({ ...BASE, AI_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('refuses a provider it does not have', () => {
    expect(() => loadConfig({ ...BASE, AI_PROVIDER: 'gemini' })).toThrow(/anthropic.*openai/i);
  });

  it('starts with no key at all, because the router still works', () => {
    // Greetings, confirmations and "who owes me" never reach a model.
    const config = loadConfig(BASE);
    expect(config.aiProvider).toBe('anthropic');
    expect(config.anthropicApiKey).toBe('');
  });
});

describe('the default model follows the provider', () => {
  it('ships one for Anthropic, by EXACT id and never an alias', () => {
    const model = loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k' }).aiModelDefault;
    /* Sonnet, not Haiku, since ADR 0031: the interpreter is accuracy-first,
     * because a misread amount that survives the schema is the one error no
     * downstream gate can catch. Haiku keeps the classifier role. */
    expect(model).toBe('claude-sonnet-5');
    /* An alias that silently moves tiers takes the price with it: cost
     * telemetry keys on the family, so last month's rate would be reported
     * against this month's bill. */
    expect(model).not.toMatch(/latest/);
  });

  /**
   * No OpenAI default ships, and that is the point.
   *
   * `gpt-4.1` leaves the API on 14 October 2026, and naming a successor here
   * would mean shipping a price this repository cannot verify against the
   * vendor's own page. Refusing at boot is the honest failure.
   */
  it('REFUSES an OpenAI-compatible provider with no model named', () => {
    expect(() => loadConfig({ ...BASE, OPENAI_API_KEY: 'k' })).toThrow(/AI_MODEL_DEFAULT/);
  });

  it('and an explicit model is all it needs', () => {
    const config = loadConfig({ ...BASE, OPENAI_API_KEY: 'k', AI_MODEL_DEFAULT: 'gpt-5-mini' });
    expect(config.aiModelDefault).toBe('gpt-5-mini');
  });

  it('lets an explicit model override the Anthropic default too', () => {
    const config = loadConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'k',
      AI_MODEL_DEFAULT: 'claude-opus-5',
    });
    expect(config.aiModelDefault).toBe('claude-opus-5');
  });
});

describe('an OpenAI-compatible endpoint that is not OpenAI', () => {
  /**
   * Groq, Together, OpenRouter and DeepSeek weights on a US host all speak
   * this wire format, so reaching one is a deployment decision rather than a
   * new adapter. Which host is a compliance decision: DeepSeek's own API is
   * PRC-hosted and trains on inputs by default.
   */
  it('carries a base URL through when one is set', () => {
    const config = loadConfig({
      ...BASE,
      OPENAI_API_KEY: 'k',
      AI_MODEL_DEFAULT: 'm',
      AI_BASE_URL: 'https://api.groq.com/openai/v1',
    });
    expect(config.aiBaseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('is null when unset, which means the provider default', () => {
    expect(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k' }).aiBaseUrl).toBeNull();
  });

  it('carries configured prices through as written', () => {
    const prices = '{"llama-3.3-70b":{"in":590000,"out":790000}}';
    const config = loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k', AI_MODEL_PRICES: prices });
    expect(config.aiModelPrices).toBe(prices);
  });
});

describe('the role ensemble (docs/ai-model-strategy.md)', () => {
  it('gives every role its documented default', () => {
    const config = loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k' });
    // Cheap where nuance does not pay, capable where it does, and OpenAI for
    // the one role Claude structurally cannot serve: audio transcription.
    expect(config.aiModelClassifier).toMatch(/haiku/);
    expect(config.aiModelVision).toMatch(/claude/);
    expect(config.aiModelEscalation).toMatch(/opus/);
    // ADR 0032: OpenAI is the launch transcriber, explicitly and only —
    // whisper-1 specifically because it reports the audio DURATION the
    // VOICE_MINUTES meter bills from. This assertion keeps the default
    // and the privacy pages describing the same engine.
    expect(config.aiModelTranscriber).toBe('whisper-1');
    // Dual-extraction threshold is configuration, defaulting to ₦500,000.
    expect(config.aiDualExtractThresholdK).toBe(50_000_000);
    /* The verifier has NO default on purpose: it must be a second vendor's
     * model, and this repository will not guess another vendor's id or
     * price. Null means dual extraction is off until a deployment opts in. */
    expect(config.aiModelVisionVerifier).toBeNull();
  });

  it('lets any role be re-pointed by env without touching code', () => {
    const config = loadConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'k',
      AI_MODEL_CLASSIFIER: 'claude-sonnet-latest',
      AI_MODEL_TRANSCRIBER: 'whisper-1',
      AI_MODEL_VISION_VERIFIER: 'gpt-test-verifier',
    });
    expect(config.aiModelClassifier).toBe('claude-sonnet-latest');
    expect(config.aiModelTranscriber).toBe('whisper-1');
    expect(config.aiModelVisionVerifier).toBe('gpt-test-verifier');
  });
});

describe('media features are explicit (ADR 0032, remediation R3)', () => {
  it('defaults both media features OFF, needing no media credentials at all', () => {
    const config = loadConfig(BASE);
    expect(config.voiceTranscriptionEnabled).toBe(false);
    expect(config.imageAiEnabled).toBe(false);
  });

  it('REFUSES voice transcription enabled without the OpenAI key', () => {
    /* The startup failure the remediation demands: a deployment that
     * promises voice and cannot deliver it fails in front of the operator,
     * never in front of a merchant. */
    expect(() => loadConfig({ ...BASE, VOICE_TRANSCRIPTION_ENABLED: '1' })).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() => loadConfig({ ...BASE, VOICE_TRANSCRIPTION_ENABLED: 'true' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it('REFUSES image AI enabled without the Anthropic key', () => {
    expect(() => loadConfig({ ...BASE, IMAGE_AI_ENABLED: '1' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('accepts each feature when its provider key is present', () => {
    const config = loadConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'k',
      OPENAI_API_KEY: 'k',
      VOICE_TRANSCRIPTION_ENABLED: '1',
      IMAGE_AI_ENABLED: 'true',
    });
    expect(config.voiceTranscriptionEnabled).toBe(true);
    expect(config.imageAiEnabled).toBe(true);
  });
});

/**
 * The voice limit stopped being decorative when it became what every note is
 * measured against before the transcriber runs. A mistyped value would
 * otherwise refuse every voice note as too long, and be chased as a metering
 * bug rather than a typo.
 */
describe('the voice length limit', () => {
  it('defaults to two minutes', () => {
    expect(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k' }).voiceNoteMaxDurationSeconds).toBe(120);
  });

  it('takes an explicit value', () => {
    const config = loadConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'k',
      VOICE_NOTE_MAX_DURATION_SECONDS: '45',
    });
    expect(config.voiceNoteMaxDurationSeconds).toBe(45);
  });

  it.each(['0', '-30', 'two minutes', '90.5', ''])('refuses %s at boot', (value) => {
    expect(() =>
      loadConfig({
        ...BASE,
        ANTHROPIC_API_KEY: 'k',
        VOICE_NOTE_MAX_DURATION_SECONDS: value,
      }),
    ).toThrow(/VOICE_NOTE_MAX_DURATION_SECONDS/);
  });
});

describe('production hardening fails closed on NODE_ENV (PR-108)', () => {
  it('treats unset, development and test as non-production', () => {
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'test' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: '' })).toBe(false);
  });

  it('treats production - and anything UNRECOGNISED - as production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    // The finding: a typo used to skip every production requirement.
    expect(isProductionEnv({ NODE_ENV: 'prod' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'Production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'staging' })).toBe(true);
  });

  it('so REKODA_REVEAL_OTP is refused under a typo`d production env', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'prod', REKODA_REVEAL_OTP: '1' })).toThrow(
      /REKODA_REVEAL_OTP/,
    );
  });
});

describe('encryption keys are shape-validated at boot (PR-106)', () => {
  it('refuses a vault key that is the right length but not hex', () => {
    expect(() => loadConfig({ ...BASE, VAULT_KEY: 'z'.repeat(64) })).toThrow(/VAULT_KEY/);
  });

  it('accepts an empty CONNECTION_KEY (the capability is off) but not a bad one', () => {
    expect(loadConfig({ ...BASE }).connectionKey).toBe('');
    expect(() => loadConfig({ ...BASE, CONNECTION_KEY: 'changeme' })).toThrow(/CONNECTION_KEY/);
    const good = 'c'.repeat(64);
    expect(loadConfig({ ...BASE, CONNECTION_KEY: good }).connectionKey).toBe(good);
  });
});

describe('PlaceOrder is the default door (remediation R2)', () => {
  it('runs the command when nothing is configured', () => {
    /* The inverted sense is the whole point: an environment that never heard
     * of the flag takes orders through the path that checks entitlement and
     * claims an idempotency key. */
    expect(loadConfig(BASE).commandPlaceOrder).toBe(true);
  });

  it('still switches off explicitly, so a rollback has somewhere to land', () => {
    expect(loadConfig({ ...BASE, REKODA_COMMAND_PLACE_ORDER: '0' }).commandPlaceOrder).toBe(false);
  });

  it('reads 1 as on, so an environment that set it during rollout is unchanged', () => {
    expect(loadConfig({ ...BASE, REKODA_COMMAND_PLACE_ORDER: '1' }).commandPlaceOrder).toBe(true);
  });

  it('leaves the sibling command flags off by default', () => {
    /* Only PlaceOrder finished its rollout. If this ever fails, a flag was
     * flipped without the proof this PR carried for its own. */
    const config = loadConfig(BASE);
    expect(config.commandRecordOrder).toBe(false);
    expect(config.commandRecordSale).toBe(false);
    expect(config.commandAdjustInventory).toBe(false);
  });
});

/**
 * The operator plane's identity (P0-2).
 *
 * Estate-wide authority used to be one reusable static header secret, and the
 * audit actor was whatever the caller typed. These pin the configuration half
 * of the replacement: production has a verified identity or it does not start,
 * and the development stand-in cannot survive into production by accident.
 */
describe('operator identity configuration', () => {
  const OIDC = {
    OPERATOR_OIDC_ISSUER: 'https://issuer.example',
    OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
    OPERATOR_OIDC_JWKS_URL: 'https://issuer.example/jwks',
  };
  const PROD = {
    ...BASE,
    NODE_ENV: 'production',
    META_APP_SECRET: 'm'.repeat(40),
    META_VERIFY_TOKEN: 'v'.repeat(40),
  } as NodeJS.ProcessEnv;

  it('is absent by default outside production, where the secret stands in', () => {
    expect(loadConfig(BASE).operatorAuth).toBeNull();
  });

  it('reads issuer, audience and key set, with OIDC scope as the default claim', () => {
    expect(loadConfig({ ...BASE, ...OIDC }).operatorAuth).toEqual({
      issuer: 'https://issuer.example',
      audience: 'rekoda-ops',
      jwksUrl: 'https://issuer.example/jwks',
      scopeClaim: 'scope',
    });
  });

  it('refuses production with no verified identity, rather than falling back', () => {
    /* The fail-closed half. A fallback that exists is a fallback somebody
     * reaches for during an incident, and an incident is exactly when
     * estate-wide authority should be hardest to get. */
    expect(() => loadConfig(PROD)).toThrow(/operator plane needs a verified identity/);
    expect(() => loadConfig({ ...PROD, ...OIDC })).not.toThrow();
  });

  it('refuses HALF a configuration everywhere, production or not', () => {
    /* Two of three is somebody mid-rollout. Treating it as "no verifier"
     * would turn a half-finished deployment change into a silent downgrade
     * to the shared secret. */
    const { OPERATOR_OIDC_JWKS_URL: _dropped, ...partial } = OIDC;
    expect(() => loadConfig({ ...BASE, ...partial })).toThrow(/or none of them/);
  });

  it('refuses a plaintext issuer or key set', () => {
    expect(() =>
      loadConfig({ ...BASE, ...OIDC, OPERATOR_OIDC_ISSUER: 'http://issuer.example' }),
    ).toThrow(/must be an https URL/);
    expect(() =>
      loadConfig({ ...BASE, ...OIDC, OPERATOR_OIDC_JWKS_URL: 'http://issuer.example/jwks' }),
    ).toThrow(/must be an https URL/);
  });

  it('refuses the development secret in production instead of ignoring it', () => {
    /* A secret sitting in a production environment reads as a live credential
     * to everyone who finds it, and the one thing worse than a shared secret
     * is a shared secret people believe still works. */
    expect(() => loadConfig({ ...PROD, ...OIDC, REKODA_OPERATOR_SECRET: 'o'.repeat(40) })).toThrow(
      /development stand-in/,
    );
  });
});

/**
 * The planning FX rate (P1).
 *
 * Cost telemetry's one constant, and the failure everybody would have missed
 * is the silent one: an empty value is not a missing value, so the default
 * never applied and every naira cost became zero.
 */
describe('the planning FX rate', () => {
  const withRate = (value: string | undefined) => {
    const env = { ...BASE } as NodeJS.ProcessEnv;
    if (value === undefined) delete env['PLANNING_FX_NGN_PER_USD'];
    else env['PLANNING_FX_NGN_PER_USD'] = value;
    return () => loadConfig(env);
  };

  it('defaults when the variable is absent', () => {
    expect(withRate(undefined)().planningFxNairaPerUsd).toBe(1_450);
  });

  it('reads a rate somebody set', () => {
    expect(withRate('1620')().planningFxNairaPerUsd).toBe(1_620);
    // Not an integer: a planning rate is a price, and prices have kobo.
    expect(withRate('1620.5')().planningFxNairaPerUsd).toBe(1_620.5);
  });

  /**
   * The quiet one, and the reason this PR exists.
   *
   * `Number(env[...] ?? 1_450)` used `??`, which only catches undefined. A
   * variable written down with nothing after it is an empty STRING, and
   * `Number('')` is 0 - so the default never applied, every AI call recorded
   * a naira cost of zero, and the margin report read as pure profit with
   * nothing anywhere saying otherwise.
   */
  it('refuses a variable set to nothing, rather than reading it as zero', () => {
    expect(withRate('')).toThrow(/PLANNING_FX_NGN_PER_USD/);
  });

  it('refuses zero and negative rates', () => {
    // Zero is the empty-string bug arriving by another road; negative would
    // record negative costs and be accepted all the way to the column.
    expect(withRate('0')).toThrow(/positive/);
    expect(withRate('-1450')).toThrow(/positive/);
  });

  it('refuses a value that is not a number at all', () => {
    /* This one did fail, but in the wrong place: NaN reaches
     * `naira_equivalent_k`, which is a bigint, and PostgreSQL REFUSES a NaN
     * rather than storing one - so the write failed inside a job, one cost
     * row at a time, long after the process started. A deployment typo
     * belongs at boot. */
    expect(withRate('abc')).toThrow(/PLANNING_FX_NGN_PER_USD/);
    expect(withRate('1,450')).toThrow(/PLANNING_FX_NGN_PER_USD/);
  });

  it('refuses an infinite rate, however it was written', () => {
    // `Number('1e400')` is Infinity, which no arithmetic below survives.
    expect(withRate('Infinity')).toThrow(/positive/);
    expect(withRate('1e400')).toThrow(/positive/);
  });
});

/**
 * The multicurrency kill switch (ADR 0033).
 *
 * Rekoda's launch is NGN-only and the FX capability is dark. Darkness that
 * depends on nobody setting a variable is a promise; these are the four
 * assertions that make it a control.
 */
describe('the dark FX capability', () => {
  it('is off when nothing says otherwise', () => {
    expect(loadConfig(BASE).fxMode).toBe('off');
  });

  it('accepts the three modes engineering may use', () => {
    expect(loadConfig({ ...BASE, FX_MODE: 'shadow' }).fxMode).toBe('shadow');
    expect(loadConfig({ ...BASE, FX_MODE: 'sandbox' }).fxMode).toBe('sandbox');
    /* Outside production `live` is loadable, so the state can be built and
     * tested before the gate that opens it exists. */
    expect(loadConfig({ ...BASE, FX_MODE: 'live' }).fxMode).toBe('live');
  });

  it('refuses to START in production on live, rather than warning', () => {
    /* Everything production demands anyway, so the refusal under test is the
     * FX one and not the first missing secret. */
    const PROD = {
      ...BASE,
      NODE_ENV: 'production',
      OPERATOR_OIDC_ISSUER: 'https://issuer.example',
      OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
      OPERATOR_OIDC_JWKS_URL: 'https://issuer.example/jwks',
      META_APP_SECRET: 'm'.repeat(40),
      META_VERIFY_TOKEN: 'v'.repeat(40),
    } as NodeJS.ProcessEnv;

    /* Off and shadow are fine in production: observing a rate moves no money
     * and exposes nothing. */
    expect(loadConfig(PROD).fxMode).toBe('off');
    expect(loadConfig({ ...PROD, FX_MODE: 'shadow' }).fxMode).toBe('shadow');

    /* The whole point. A deployment that came up with live FX believing it
     * was configured to is the accident the mode exists to prevent, so this
     * is a boot failure and not a log line. */
    expect(() => loadConfig({ ...PROD, FX_MODE: 'live' })).toThrow(/has not been graduated/);
  });

  it('refuses a mode it does not know instead of falling back to off', () => {
    /* Falling back would be the safe VALUE reached by the unsafe ROUTE: a
     * typo would silently become `off`, and the day the gate opens the same
     * typo silently becomes `off` again on a deployment that meant `live`. */
    expect(() => loadConfig({ ...BASE, FX_MODE: 'on' })).toThrow(/FX_MODE must be one of/);
    expect(() => loadConfig({ ...BASE, FX_MODE: 'OFF' })).toThrow(/FX_MODE must be one of/);
  });
});

describe('numeric configuration fails closed (launch closeout)', () => {
  /* One list, every rewired variable, so a NEW numeric env read that skips
   * the validators shows up as a missing row here rather than as a silent
   * NaN in production. */
  const POSITIVE = ['REKODA_RATE_LIMIT_MAX', 'REKODA_SHOP_ORDERS_PER_HOUR'] as const;
  const NON_NEGATIVE = [
    'REKODA_TRANSFER_VERIFY_MIN_SECONDS',
    'AI_DAILY_CALLS_PER_BUSINESS',
    'AI_DAILY_CALLS_GLOBAL',
    'AI_DOC_EXTRACTIONS_GLOBAL',
    'VOICE_SECONDS_PER_BUSINESS_PER_DAY',
    'VOICE_SECONDS_GLOBAL_PER_DAY',
    'AI_DUAL_EXTRACT_THRESHOLD_K',
    'AI_DOC_EXTRACTIONS_PER_BUSINESS',
    'META_SERVICE_REPLY_COST_MICROS',
  ] as const;

  it.each([...POSITIVE, ...NON_NEGATIVE, 'PORT', 'REKODA_WORKER_CONCURRENCY'])(
    '%s: garbage refuses to boot, naming the variable',
    (name) => {
      expect(() => loadConfig({ ...BASE, [name]: 'oops' })).toThrow(new RegExp(name));
    },
  );

  it.each([...POSITIVE, ...NON_NEGATIVE, 'PORT', 'REKODA_WORKER_CONCURRENCY'])(
    '%s: present-but-blank is a question, not a default',
    (name) => {
      /* `NAME=` with nothing after it: `??` never sees it and `Number('')`
       * is 0, so before this PR a blank cost brake was silently ZERO - or
       * silently unlimited-looking, depending on the comparison. Somebody
       * wrote the name down and left the value off; boot asks. */
      expect(() => loadConfig({ ...BASE, [name]: '' })).toThrow(new RegExp(name));
    },
  );

  it('zero is refused where only a positive value can work', () => {
    expect(() => loadConfig({ ...BASE, REKODA_RATE_LIMIT_MAX: '0' })).toThrow(
      /REKODA_RATE_LIMIT_MAX/,
    );
    expect(() => loadConfig({ ...BASE, REKODA_WORKER_CONCURRENCY: '0' })).toThrow(
      /REKODA_WORKER_CONCURRENCY/,
    );
  });

  it('zero is a VALUE for the brakes - a kill switch, never unlimited', () => {
    /* PR-014's rule holds at the config boundary too: an operator halting
     * AI spend with AI_DAILY_CALLS_GLOBAL=0 gets zero calls, and the
     * storefront-transfer suite's verify window of 0 stays legal. */
    const config = loadConfig({
      ...BASE,
      AI_DAILY_CALLS_GLOBAL: '0',
      REKODA_TRANSFER_VERIFY_MIN_SECONDS: '0',
    });
    expect(config.aiCallsGlobalPerDay).toBe(0);
    expect(config.transferVerifyMinSeconds).toBe(0);
  });

  it('a fraction is not a quota', () => {
    expect(() => loadConfig({ ...BASE, AI_DAILY_CALLS_GLOBAL: '2.5' })).toThrow(
      /AI_DAILY_CALLS_GLOBAL/,
    );
  });

  it('the worker floor cannot be defeated by NaN any more', () => {
    /* The old `Math.max(1, Number(...))` looked like a floor and was not:
     * `Math.max(1, NaN)` is NaN, and a NaN concurrency starts no lanes. */
    expect(() => loadConfig({ ...BASE, REKODA_WORKER_CONCURRENCY: 'four' })).toThrow(
      /REKODA_WORKER_CONCURRENCY/,
    );
    expect(loadConfig({ ...BASE, REKODA_WORKER_CONCURRENCY: '8' }).workerConcurrency).toBe(8);
  });

  it('PORT is bounded to what TCP can serve', () => {
    expect(() => loadConfig({ ...BASE, PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...BASE, PORT: '70000' })).toThrow(/PORT/);
    expect(loadConfig({ ...BASE, PORT: '8080' }).port).toBe(8080);
  });

  it('unset still means the documented default, exactly as before', () => {
    const config = loadConfig({ ...BASE });
    expect(config.rateLimitMax).toBe(60);
    expect(config.shopOrdersPerHour).toBe(120);
    expect(config.transferVerifyMinSeconds).toBe(5);
    expect(config.workerConcurrency).toBe(4);
    expect(config.aiCallsPerBusinessPerDay).toBe(60);
    expect(config.aiCallsGlobalPerDay).toBe(5_000);
    expect(config.aiDocExtractionsGlobalPerDay).toBe(2_000);
    expect(config.voiceSecondsPerBusinessPerDay).toBe(1_800);
    expect(config.voiceSecondsGlobalPerDay).toBe(36_000);
    expect(config.aiDualExtractThresholdK).toBe(50_000_000);
    expect(config.aiDocExtractionsPerBusinessPerDay).toBe(25);
    expect(config.metaServiceReplyCostMicros).toBe(0);
    expect(config.port).toBe(3001);
  });
});
