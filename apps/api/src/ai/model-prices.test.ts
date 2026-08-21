/**
 * Model prices as configuration — the ones core deliberately does not ship.
 *
 * Two claims worth pinning. The ORDERING: `modelFamily` matches the first
 * family whose name the model id contains, so a registry that puts `gpt-5` in
 * before `gpt-5-mini` costs every mini call at the full tier and nothing
 * anywhere says so — a margin bug that reads as a margin. And the REFUSALS:
 * every malformed price has to throw rather than be skipped, because a price
 * that was quietly dropped is exactly a silently free model.
 */
import { describe, expect, it } from 'vitest';
import { costOfCall, modelFamily } from '@rekoda/core';
import {
  assertModelIsPriced,
  BadModelPrices,
  parseModelPrices,
  registerRuntimeModelPrices,
  UnpricedModel,
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

    // If ordering broke, all three would be 9_000_000.
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

describe('reading the configuration', () => {
  it('treats an absent or empty value as no extra prices', () => {
    expect(parseModelPrices(undefined)).toEqual({});
    expect(parseModelPrices('   ')).toEqual({});
  });

  it('refuses invalid JSON rather than starting with no prices', () => {
    expect(() => parseModelPrices('{not json')).toThrow(BadModelPrices);
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
