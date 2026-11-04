/**
 * Media configuration: voice transcription and image AI are explicit, and each
 * refuses to boot without the key its provider needs (ADR 0032). The voice
 * length limit is what every note is measured against before transcription.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

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
