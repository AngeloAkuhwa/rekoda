/**
 * Choosing a provider (owner directive, 19 Aug 2026: keep it open to both).
 *
 * The interesting cases are all about ambiguity — no key, both keys, a key
 * that contradicts an explicit choice — because that is where a wrong default
 * silently sends a merchant's money message to a model nobody picked.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const BASE = {
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/x',
  OTP_PEPPER: 'p'.repeat(40),
  REKODA_API_SECRET: 's'.repeat(40),
  VAULT_KEY: 'a'.repeat(64),
  MATCH_KEY: 'b'.repeat(64),
} as NodeJS.ProcessEnv;

describe('picking a provider', () => {
  it('follows an explicit choice', () => {
    expect(loadConfig({ ...BASE, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }).aiProvider).toBe(
      'openai',
    );
    expect(
      loadConfig({ ...BASE, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).aiProvider,
    ).toBe('anthropic');
  });

  it('uses whichever key is present when no choice is made', () => {
    expect(loadConfig({ ...BASE, OPENAI_API_KEY: 'k' }).aiProvider).toBe('openai');
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
  it('because a model id is not portable between them', () => {
    expect(loadConfig({ ...BASE, ANTHROPIC_API_KEY: 'k' }).aiModelDefault).toMatch(/claude/);
    expect(loadConfig({ ...BASE, OPENAI_API_KEY: 'k' }).aiModelDefault).toMatch(/gpt/);
  });

  it('and an explicit model wins over both', () => {
    const config = loadConfig({ ...BASE, OPENAI_API_KEY: 'k', AI_MODEL_DEFAULT: 'o4-mini' });
    expect(config.aiModelDefault).toBe('o4-mini');
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
    // ADR 0008: the transcriber defaults to the SELF-HOSTED AfriSpeech-tuned
    // sidecar, never a hosted API — "audio never leaves Rekoda" is a trust
    // claim, and this assertion is what keeps a convenience swap from
    // sneaking in as a default.
    expect(config.aiModelTranscriber).toMatch(/afrispeech/);
    // Dual-extraction threshold is configuration, defaulting to ₦500,000.
    expect(config.aiDualExtractThresholdK).toBe(50_000_000);
  });

  it('lets any role be re-pointed by env without touching code', () => {
    const config = loadConfig({
      ...BASE,
      ANTHROPIC_API_KEY: 'k',
      AI_MODEL_CLASSIFIER: 'claude-sonnet-latest',
      AI_MODEL_TRANSCRIBER: 'whisper-1',
    });
    expect(config.aiModelClassifier).toBe('claude-sonnet-latest');
    expect(config.aiModelTranscriber).toBe('whisper-1');
  });
});
