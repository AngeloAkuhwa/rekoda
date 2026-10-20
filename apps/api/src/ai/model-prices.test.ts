/**
 * Model prices as configuration — the ones core deliberately does not ship.
 *
 * Two claims worth pinning. The MATCHING: a family is its whole id or a dated
 * snapshot of it, so `gpt-5` never costs a `gpt-5-mini` call at the full tier,
 * whatever order they were registered in (G-59). And the REFUSALS:
 * every malformed price has to throw rather than be skipped, because a price
 * that was quietly dropped is exactly a silently free model.
 */
import { describe, expect, it } from 'vitest';
import { costOfCall, costOfTranscription, modelFamily } from '@rekoda/core';
import {
  assertModelIsPriced,
  assertTranscriberIsPriced,
  BadModelPrices,
  BadTranscriptionPrices,
  parseModelPrices,
  parseTranscriptionPrices,
  registerRuntimeModelPrices,
  registerRuntimeTranscriptionPrices,
  UnpricedModel,
  assertRolesArePriced,
} from './model-prices.js';

const FX = 1_450;
const usage = { inputTokens: 1_000_000, outputTokens: 0 };

/* Figures chosen to be distinguishable, not to be anybody's real price list:
 * the point of this file is that prices arrive from whoever holds the
 * invoice. */
registerRuntimeModelPrices(
  JSON.stringify({
    'test-tier': { in: 9_000_000, out: 9_000_000 },
    'test-tier-mini': { in: 300_000, out: 300_000 },
    'test-tier-nano': { in: 50_000, out: 50_000, cacheRead: 5_000 },
  }),
);

describe('configured families', () => {
  it('costs the mini and nano tiers as themselves, not as their parent', () => {
    expect(modelFamily('test-tier-mini')).toBe('test-tier-mini');
    expect(modelFamily('test-tier-nano')).toBe('test-tier-nano');
    expect(modelFamily('test-tier')).toBe('test-tier');

    // Registered parent first: under containment without the old length sort, all three would cost 9_000_000.
    expect(costOfCall('test-tier', usage, FX).usdMicros).toBe(9_000_000);
    expect(costOfCall('test-tier-mini', usage, FX).usdMicros).toBe(300_000);
    expect(costOfCall('test-tier-nano', usage, FX).usdMicros).toBe(50_000);
  });

  it('prices a dated snapshot id by its family', () => {
    const cost = costOfCall('test-tier-mini-2026-04-14', usage, FX);
    expect(cost.priced).toBe(true);
    expect(cost.usdMicros).toBe(300_000);
  });

  it('still refuses to invent a price for a model it has never seen', () => {
    const cost = costOfCall('some-new-model-v9', usage, FX);
    expect(cost.priced).toBe(false);
    expect(cost.usdMicros).toBe(0);
  });

  it('defaults a cache read to a tenth of input when none is given', () => {
    const cached = costOfCall(
      'test-tier-mini',
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      FX,
    );
    expect(cached.usdMicros).toBe(30_000);
  });
});

/**
 * G-59. A configured family is matched by the WHOLE id, or by the id plus a
 * dated snapshot suffix, never by containment and never by a bare prefix: a
 * deployment that configured only `gpt-5` and then runs `gpt-5-mini` has an
 * unpriced model, not a mini priced at the full tier.
 */
describe('configured families match whole ids, not fragments (G-59)', () => {
  registerRuntimeModelPrices(
    JSON.stringify({
      'gpt-5': { in: 1_250_000, out: 10_000_000 },
      'acme-chat': { in: 700_000, out: 700_000 },
    }),
  );

  it('prices the configured id and its dated snapshots', () => {
    expect(modelFamily('gpt-5')).toBe('gpt-5');
    expect(modelFamily('GPT-5')).toBe('gpt-5');
    expect(modelFamily('gpt-5-2025-08-07')).toBe('gpt-5');
    expect(modelFamily('gpt-5-20250807')).toBe('gpt-5');
    expect(costOfCall('gpt-5-2025-08-07', usage, FX).usdMicros).toBe(1_250_000);
  });

  it('leaves a sibling tier unpriced instead of costing it as its parent', () => {
    // Old rule: "gpt-5-mini" contains "gpt-5", so it cost $1.25 per MTok in.
    for (const id of ['gpt-5-mini', 'gpt-5-nano', 'gpt-5-mini-2025-08-07', 'gpt-5.1', 'gpt-50']) {
      expect(modelFamily(id)).toBeNull();
      expect(costOfCall(id, usage, FX).priced).toBe(false);
    }
  });

  it('does not match a configured family that only appears inside an id', () => {
    for (const id of ['my-gpt-5', 'openrouter/gpt-5-fork', 'acme-chat-pro', 'xacme-chat']) {
      expect(modelFamily(id)).toBeNull();
    }
    expect(() => assertModelIsPriced('gpt-5-mini', true)).toThrow(UnpricedModel);
  });

  it('does not take a moving alias as a snapshot', () => {
    expect(modelFamily('gpt-5-latest')).toBeNull();
    expect(modelFamily('acme-chat-preview')).toBeNull();
  });

  it('prefers a configured exact id over a shorter family plus a snapshot suffix', () => {
    // Registered alias first, snapshot second: insertion order must not decide.
    registerRuntimeModelPrices(
      JSON.stringify({
        'order-test': { in: 1_000_000, out: 1_000_000 },
        'order-test-2026-01-01': { in: 2_000_000, out: 2_000_000 },
      }),
    );
    expect(modelFamily('order-test-2026-01-01')).toBe('order-test-2026-01-01');
    expect(costOfCall('order-test-2026-01-01', usage, FX).usdMicros).toBe(2_000_000);
    expect(modelFamily('order-test-2026-02-01')).toBe('order-test');
  });

  /* The id is sent to the provider as configured, so a stray space or \r
   * from an edited env file must refuse to boot, never pass the price check
   * and then fail every call (CLAUDE.md invariant 8). */
  it('leaves a configured id with stray whitespace unpriced, so boot refuses it', () => {
    expect(modelFamily(' gpt-5\r')).toBeNull();
    expect(() => assertModelIsPriced('gpt-5\r', true)).toThrow(UnpricedModel);
    // A shipped Claude id too: Anthropic is the default provider.
    for (const id of ['claude-sonnet-5\r', ' claude-haiku-4-5', 'claude-opus-5 ']) {
      expect(modelFamily(id)).toBeNull();
      expect(() => assertModelIsPriced(id, true)).toThrow(UnpricedModel);
    }
  });

  it('lets a configured exact id override the built-in Claude family', () => {
    registerRuntimeModelPrices(
      JSON.stringify({ 'claude-sonnet-4-5': { in: 3_000_000, out: 15_000_000 } }),
    );
    expect(modelFamily('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(costOfCall('claude-sonnet-4-5-20250929', usage, FX).usdMicros).toBe(3_000_000);
    // The shipped id is untouched by it.
    expect(modelFamily('claude-sonnet-5')).toBe('sonnet');
  });
});

describe('reading the configuration', () => {
  it('treats an absent or empty value as no extra prices', () => {
    expect(parseModelPrices(undefined)).toEqual({});
    expect(parseModelPrices('   ')).toEqual({});
  });

  it('refuses invalid JSON rather than starting with no prices', () => {
    expect(() => parseModelPrices('{not json')).toThrow(BadModelPrices);
  });

  it('refuses a key that is a built-in family name, which would be silently ignored', () => {
    expect(() => parseModelPrices('{"sonnet":{"in":3000000,"out":15000000}}')).toThrow(
      BadModelPrices,
    );
    expect(() => parseModelPrices('{"Opus":{"in":1,"out":1}}')).toThrow(BadModelPrices);
  });

  it('refuses a shape that is not an object keyed by family', () => {
    expect(() => parseModelPrices('[]')).toThrow(BadModelPrices);
    expect(() => parseModelPrices('"gpt-5"')).toThrow(BadModelPrices);
  });

  /* Each of these would otherwise register as zero, and a zero price is a
   * free model in the margin view. */
  it('refuses a price missing either half', () => {
    expect(() => parseModelPrices('{"m":{"in":100}}')).toThrow(BadModelPrices);
    expect(() => parseModelPrices('{"m":{"out":100}}')).toThrow(BadModelPrices);
  });

  it('refuses a price that is zero, negative or not a number', () => {
    expect(() => parseModelPrices('{"m":{"in":0,"out":1}}')).toThrow(BadModelPrices);
    expect(() => parseModelPrices('{"m":{"in":-1,"out":1}}')).toThrow(BadModelPrices);
    expect(() => parseModelPrices('{"m":{"in":"1","out":1}}')).toThrow(BadModelPrices);
  });

  it('keeps an explicit cache price when one is given', () => {
    expect(parseModelPrices('{"m":{"in":10,"out":20,"cacheRead":1}}')['m']).toMatchObject({
      cacheRead: 1,
    });
  });
});

describe('the boot check', () => {
  it('refuses to start with a key and an unpriced model', () => {
    expect(() => assertModelIsPriced('some-new-model-v9', true)).toThrow(UnpricedModel);
  });

  it('says nothing when there is no key: no calls, nothing to misprice', () => {
    expect(() => assertModelIsPriced('some-new-model-v9', false)).not.toThrow();
  });

  /**
   * The models the product actually ships with, by exact id. These are the
   * ids in config.ts, and an alias like `claude-sonnet-latest` is deliberately
   * not among them: an alias that moves tiers takes the price with it.
   */
  it('accepts every model the product ships with, priced by core', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']) {
      expect(() => assertModelIsPriced(model, true)).not.toThrow();
    }
  });
});

describe('the whole ensemble is priced at boot (ADR 0031)', () => {
  it('refuses when ANY configured role names an unpriced model', () => {
    /* The interpreter being priced is not enough: a classifier or an
     * escalation model with no price would report its every call as free,
     * which is precisely the outcome the margin view exists to prevent. */
    expect(() => assertRolesArePriced(['claude-sonnet-5', 'gpt-nonexistent-tier'], true)).toThrow(
      UnpricedModel,
    );
  });

  it('passes a fully-priced ensemble, deduplicating shared models', () => {
    expect(() =>
      assertRolesArePriced(
        ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
        true,
      ),
    ).not.toThrow();
  });

  it('stays quiet with no key, because no key means no calls to misprice', () => {
    expect(() => assertRolesArePriced(['completely-unknown-model'], false)).not.toThrow();
  });
});

describe('per-minute transcription prices', () => {
  it('parses a valid price and prices a real call with it', () => {
    registerRuntimeTranscriptionPrices('{"test-transcriber":{"perMinuteMicros":6000}}');
    // Two minutes at $0.006/min = $0.012 = 12,000 micros.
    expect(costOfTranscription('test-transcriber', 120, FX).usdMicros).toBe(12_000);
  });

  it('refuses invalid JSON rather than skipping it', () => {
    expect(() => parseTranscriptionPrices('not json')).toThrow(BadTranscriptionPrices);
  });

  it('refuses a price without a positive perMinuteMicros', () => {
    for (const bad of [
      '{"m":{}}',
      '{"m":{"perMinuteMicros":0}}',
      '{"m":{"perMinuteMicros":-5}}',
      '{"m":{"perMinuteMicros":"6000"}}',
      '["not-an-object"]',
    ]) {
      expect(() => parseTranscriptionPrices(bad)).toThrow(BadTranscriptionPrices);
    }
  });

  it('treats an empty value as no prices, not as an error', () => {
    expect(parseTranscriptionPrices(undefined)).toEqual({});
    expect(parseTranscriptionPrices('  ')).toEqual({});
  });
});

describe('the hosted transcriber must be priced at boot', () => {
  it('refuses a hosted transcriber with no per-minute price', () => {
    expect(() => assertTranscriberIsPriced('never-priced-transcriber', true)).toThrow(
      UnpricedModel,
    );
  });

  it('accepts a hosted transcriber once its price is registered', () => {
    registerRuntimeTranscriptionPrices('{"priced-transcriber":{"perMinuteMicros":4500}}');
    expect(() => assertTranscriberIsPriced('priced-transcriber', true)).not.toThrow();
  });

  it('stays quiet when hosted transcription is not the active configuration', () => {
    /* Voice disabled makes no transcriptions — nothing to misprice. */
    expect(() => assertTranscriberIsPriced('never-priced-transcriber', false)).not.toThrow();
  });
});
