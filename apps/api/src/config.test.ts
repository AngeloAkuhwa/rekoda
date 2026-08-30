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
