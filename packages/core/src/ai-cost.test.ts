/**
 * What a model call cost (MASTER-PLAN §5.3.3).
 *
 * The number these functions produce is what the margin view is built on six
 * weeks after launch, so the tests here are mostly about the two ways a cost
 * calculation lies: floating-point drift, and treating "we don't know" as
 * "free".
 */
import { describe, expect, it } from 'vitest';
import {
  billingPeriod,
  cacheSaving,
  costOfCall,
  costOfTranscription,
  hasTranscriptionPrice,
  modelFamily,
  registerTranscriptionPrice,
} from './ai-cost.js';
import { usagePeriod } from './allowances.js';

const FX = 1_450; // PLANNING_FX_NGN_PER_USD

describe('pricing a call', () => {
  it('prices a Sonnet call at the permanent published rate', () => {
    /* 1M in at $2, 1M out at $10 = $12. $2/$10 began as an introductory rate
     * and became Sonnet 5's standing list price; the table follows the
     * vendor's page. Rows written under the earlier $3/$15 entry keep the
     * cost they recorded — this prices future calls, never rewrites rows. */
    const cost = costOfCall(
      'claude-sonnet-5',
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
    /* The classifier's real shape: 1,800 in and 220 out on Haiku.
     * 1,800 × $1/MTok + 220 × $5/MTok. (The interpreter itself reads on
     * Sonnet since ADR 0031; this pins the cheap tier's arithmetic.) */
    const cost = costOfCall(
      'claude-haiku-4-5',
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
    expect(cost.usdMicros).toBe(2_900);
  });

  it('charges cache writes more than input and cache reads far less', () => {
    const write = costOfCall(
      'claude-sonnet-5',
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
      },
      FX,
    );
    const read = costOfCall(
      'claude-sonnet-5',
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      },
      FX,
    );

    expect(write.usdMicros).toBe(2_500_000); // 1.25× input (5-minute cache)
    expect(read.usdMicros).toBe(200_000); // 0.10× input
  });

  it('prices Haiku below Sonnet below Fable', () => {
    const usage = { inputTokens: 100_000, outputTokens: 10_000 };
    const haiku = costOfCall('claude-haiku-4-5', usage, FX).usdMicros;
    const sonnet = costOfCall('claude-sonnet-5', usage, FX).usdMicros;
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
    const atLaunch = costOfCall('claude-sonnet-5', usage, 1_450).nairaKobo;
    const later = costOfCall('claude-sonnet-5', usage, 2_000).nairaKobo;

    // Which is why the rate is an argument. Re-deriving a past row's naira
    // cost from today's FX would silently rewrite history.
    expect(later).toBeGreaterThan(atLaunch);
    // 1M input on Sonnet at $2/MTok = $2 × ₦1,450 = ₦2,900 = 290,000 kobo.
    expect(atLaunch).toBe(290_000);
  });
});

describe('what prompt caching is worth', () => {
  it('saves 90% on the cached portion', () => {
    // The claim that justifies the complexity, as a number rather than a
    // comment: cache reads are a tenth of input price.
    expect(cacheSaving('claude-sonnet-5', 10_000)).toBeCloseTo(0.9, 5);
    expect(cacheSaving('claude-haiku-4-5', 10_000)).toBeCloseTo(0.9, 5);
  });

  it('is zero for a model we cannot price', () => {
    expect(cacheSaving('unknown', 10_000)).toBe(0);
  });
});

describe('pricing a transcription by the minute', () => {
  it('pro-rates a registered per-minute price to the second', () => {
    registerTranscriptionPrice('whisper-test', { perMinuteMicros: 6_000 });
    // 90 seconds at $0.006/min = $0.009 = 9,000 micros.
    const cost = costOfTranscription('whisper-test', 90, FX);
    expect(cost.usdMicros).toBe(9_000);
    expect(cost.priced).toBe(true);
    // 9,000 micros × ₦1,450 / 10,000 = 1,305 kobo — integers all the way.
    expect(cost.nairaKobo).toBe(1_305);
    expect(Number.isInteger(cost.nairaKobo)).toBe(true);
  });

  it('reports an unregistered transcriber as unpriced, never as free', () => {
    const cost = costOfTranscription('some-transcriber-nobody-priced', 120, FX);
    expect(cost.usdMicros).toBe(0);
    expect(cost.priced).toBe(false);
    expect(hasTranscriptionPrice('some-transcriber-nobody-priced')).toBe(false);
  });

  it('matches the model id case-insensitively, like the token table', () => {
    registerTranscriptionPrice('GPT-Transcribe', { perMinuteMicros: 4_500 });
    expect(hasTranscriptionPrice('gpt-transcribe')).toBe(true);
    // One minute exactly: the per-minute price, verbatim.
    expect(costOfTranscription('gpt-transcribe', 60, FX).usdMicros).toBe(4_500);
  });

  it('never charges negative seconds', () => {
    registerTranscriptionPrice('whisper-test', { perMinuteMicros: 6_000 });
    expect(costOfTranscription('whisper-test', -5, FX).usdMicros).toBe(0);
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

describe('the billing period ties to the meter', () => {
  it('uses the LAGOS month, the same one usagePeriod counts in', () => {
    // 23:30 UTC on the last day of August is 00:30 on 1 September in Lagos.
    // The counter has already rolled; the cost row must roll with it, or the
    // margin view can never tie to the meter it explains.
    const lateAugust = new Date('2026-08-31T23:30:00Z');
    expect(billingPeriod(lateAugust)).toBe('2026-09');
    expect(billingPeriod(lateAugust)).toBe(usagePeriod(lateAugust));
  });

  it('agrees with the meter across an ordinary month too', () => {
    const midMonth = new Date('2026-08-15T09:00:00Z');
    expect(billingPeriod(midMonth)).toBe(usagePeriod(midMonth));
  });
});
