/**
 * What a model call cost (MASTER-PLAN §5.3.3).
 *
 * The number these functions produce is what the margin view is built on six
 * weeks after launch, so the tests here are mostly about the two ways a cost
 * calculation lies: floating-point drift, and treating "we don't know" as
 * "free".
 */
import { describe, expect, it } from 'vitest';
import { billingPeriod, cacheSaving, costOfCall, modelFamily } from './ai-cost.js';

const FX = 1_450; // PLANNING_FX_NGN_PER_USD

describe('pricing a call', () => {
  it('prices a Sonnet call at the published rate', () => {
    // 1M in at $2, 1M out at $10 = $12 = 12,000,000 micro-USD.
    const cost = costOfCall(
      'claude-sonnet-latest',
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      FX,
    );
    expect(cost.usdMicros).toBe(12_000_000);
    expect(cost.priced).toBe(true);
    // $12 × ₦1,450 = ₦17,400 = 1,740,000 kobo.
    expect(cost.nairaKobo).toBe(1_740_000);
  });

  it('prices a realistic single call in whole kobo', () => {
    const cost = costOfCall(
      'claude-sonnet-latest',
      {
        inputTokens: 1_800,
        outputTokens: 220,
      },
      FX,
    );
    // Integers throughout — no fractional kobo to accumulate into a wrong
    // margin over a hundred thousand calls.
    expect(Number.isInteger(cost.usdMicros)).toBe(true);
    expect(Number.isInteger(cost.nairaKobo)).toBe(true);
    expect(cost.usdMicros).toBe(5_800);
  });

  it('charges cache writes more than input and cache reads far less', () => {
    const write = costOfCall(
      'claude-sonnet-latest',
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
      },
      FX,
    );
    const read = costOfCall(
      'claude-sonnet-latest',
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      },
      FX,
    );

    expect(write.usdMicros).toBe(2_500_000); // 1.25× input
    expect(read.usdMicros).toBe(200_000); // 0.10× input
  });

  it('prices Haiku below Sonnet below Fable', () => {
    const usage = { inputTokens: 100_000, outputTokens: 10_000 };
    const haiku = costOfCall('claude-haiku-latest', usage, FX).usdMicros;
    const sonnet = costOfCall('claude-sonnet-latest', usage, FX).usdMicros;
    const fable = costOfCall('claude-fable-5', usage, FX).usdMicros;
    expect(haiku).toBeLessThan(sonnet);
    expect(sonnet).toBeLessThan(fable);
  });
});

describe('a model we have no price for', () => {
  it('reports zero cost AND says it is unpriced', () => {
    const cost = costOfCall(
      'some-model-we-added-on-friday',
      {
        inputTokens: 500_000,
        outputTokens: 500_000,
      },
      FX,
    );

    // Zero, but a zero that admits it. Silently recording an unpriced model
    // as free would not look like a bug — it would look like good margin.
    expect(cost.usdMicros).toBe(0);
    expect(cost.priced).toBe(false);
  });

  it('recognises a family inside a dated snapshot id', () => {
    expect(modelFamily('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('gpt-4o')).toBeNull();
  });
});

describe('the FX rate is recorded, not re-derived', () => {
  it('produces a different naira figure at a different rate', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0 };
    const atLaunch = costOfCall('claude-sonnet-latest', usage, 1_450).nairaKobo;
    const later = costOfCall('claude-sonnet-latest', usage, 2_000).nairaKobo;

    // Which is why the rate is an argument. Re-deriving a past row's naira
    // cost from today's FX would silently rewrite history.
    expect(later).toBeGreaterThan(atLaunch);
    expect(atLaunch).toBe(290_000);
  });
});

describe('what prompt caching is worth', () => {
  it('saves 90% on the cached portion', () => {
    // The claim that justifies the complexity, as a number rather than a
    // comment: cache reads are a tenth of input price.
    expect(cacheSaving('claude-sonnet-latest', 10_000)).toBeCloseTo(0.9, 5);
    expect(cacheSaving('claude-haiku-latest', 10_000)).toBeCloseTo(0.9, 5);
  });

  it('is zero for a model we cannot price', () => {
    expect(cacheSaving('unknown', 10_000)).toBe(0);
  });
});

describe('billing period', () => {
  it('is the UTC month', () => {
    expect(billingPeriod(new Date('2026-08-19T23:30:00Z'))).toBe('2026-08');
    expect(billingPeriod(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    // Zero-padded, so string sorting is chronological.
    expect(billingPeriod(new Date('2026-09-30T12:00:00Z'))).toBe('2026-09');
  });
});
