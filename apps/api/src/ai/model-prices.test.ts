/**
 * Runtime model prices — the ones core deliberately does not ship.
 *
 * The claim worth pinning is the ordering: `modelFamily` matches the first
 * family whose name the model id contains, so a registry that puts `gpt-4.1`
 * in before `gpt-4.1-mini` costs every mini call at five times its price and
 * nothing anywhere would say so. That is a margin bug that reads as a margin.
 */
import { describe, expect, it } from 'vitest';
import { costOfCall, modelFamily } from '@rekoda/core';
import { assertModelIsPriced, registerRuntimeModelPrices, UnpricedModel } from './model-prices.js';

registerRuntimeModelPrices();

const FX = 1_450;
const usage = { inputTokens: 1_000_000, outputTokens: 0 };

describe('OpenAI families', () => {
  it('costs the mini and nano tiers as themselves, not as their parent', () => {
    expect(modelFamily('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(modelFamily('gpt-4.1-nano')).toBe('gpt-4.1-nano');
    expect(modelFamily('gpt-4.1')).toBe('gpt-4.1');

    // $2 / $0.40 / $0.10 per MTok input. If ordering broke, all three of
    // these would be 2_000_000.
    expect(costOfCall('gpt-4.1', usage, FX).usdMicros).toBe(2_000_000);
    expect(costOfCall('gpt-4.1-mini', usage, FX).usdMicros).toBe(400_000);
    expect(costOfCall('gpt-4.1-nano', usage, FX).usdMicros).toBe(100_000);
  });

  it('prices a dated snapshot id by its family', () => {
    const cost = costOfCall('gpt-4.1-mini-2025-04-14', usage, FX);
    expect(cost.priced).toBe(true);
    expect(cost.usdMicros).toBe(400_000);
  });

  it('still refuses to invent a price for a model it has never seen', () => {
    const cost = costOfCall('some-new-model-v9', usage, FX);
    expect(cost.priced).toBe(false);
    expect(cost.usdMicros).toBe(0);
  });
});

describe('the boot check', () => {
  it('refuses to start with a key and an unpriced model', () => {
    expect(() => assertModelIsPriced('some-new-model-v9', true)).toThrow(UnpricedModel);
  });

  it('says nothing when there is no key: no calls, nothing to misprice', () => {
    expect(() => assertModelIsPriced('some-new-model-v9', false)).not.toThrow();
  });

  it('accepts every model the product actually ships with', () => {
    for (const model of ['claude-sonnet-latest', 'claude-haiku-latest', 'gpt-4.1-mini']) {
      expect(() => assertModelIsPriced(model, true)).not.toThrow();
    }
  });
});
