/**
 * Numeric configuration fails closed: garbage, blanks and loosely written
 * numbers refuse to boot, zero is a legal kill switch where it means one, and
 * unset keeps the documented default.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

describe('numeric configuration fails closed (launch closeout)', () => {
  /* One list, every rewired variable, so a NEW numeric env read that skips
   * the validators shows up as a missing row here rather than as a silent
   * NaN in production. */
  const POSITIVE = ['REKODA_RATE_LIMIT_MAX'] as const;
  const NON_NEGATIVE = [
    'REKODA_SHOP_ORDERS_PER_HOUR',
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
      REKODA_SHOP_ORDERS_PER_HOUR: '0',
    });
    expect(config.aiCallsGlobalPerDay).toBe(0);
    expect(config.transferVerifyMinSeconds).toBe(0);
    /* The shop gate is `recent >= limit`, so 0 answers every storefront
     * order `busy` - an operator halting a flood mid-incident must not have
     * the whole API refuse to boot instead. */
    expect(config.shopOrdersPerHour).toBe(0);
  });

  it('an integer is WRITTEN as an integer, not merely parseable as one', () => {
    /* Number() reads hex, exponents, signed zero and trailing decimals;
     * each of those in an env file is somebody not saying what they meant.
     * Fail closed covers the form, not just the value. */
    for (const written of ['0x50', '6e1', '-0', '2.0', '+5']) {
      expect(() => loadConfig({ ...BASE, AI_DAILY_CALLS_GLOBAL: written })).toThrow(
        /AI_DAILY_CALLS_GLOBAL/,
      );
    }
    expect(() => loadConfig({ ...BASE, PORT: '0x1F90' })).toThrow(/PORT/);
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
