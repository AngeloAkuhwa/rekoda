import { describe, expect, it } from 'vitest';
import { selectRate, type ExchangeRateSnapshot } from './fx.js';

const DAY = 24 * 60 * 60 * 1000;

function snap(effectiveAt: string, id = 'r1'): ExchangeRateSnapshot {
  return {
    id,
    baseCurrency: 'USD',
    quoteCurrency: 'NGN',
    rate: '1512.3456789',
    effectiveAt: new Date(effectiveAt),
    fetchedAt: new Date('2026-06-15T09:00:00Z'),
    source: 'PROVIDER',
    providerName: 'test',
  };
}

describe('selectRate (Appendix A.2)', () => {
  it('a June rate answers a June request in December: staleness is against the requested timestamp', () => {
    const june = snap('2026-06-15T00:00:00Z');
    /* "Today" is irrelevant — the request carries its own moment. */
    const out = selectRate([june], 'USD', 'NGN', new Date('2026-06-15T06:00:00Z'), DAY);
    expect(out.state).toBe('RATE_AVAILABLE');
  });

  it("today's rate can never silently satisfy a historical request", () => {
    const today = snap('2026-12-01T00:00:00Z');
    const out = selectRate([today], 'USD', 'NGN', new Date('2026-06-15T00:00:00Z'), DAY);
    expect(out.state).toBe('RATE_STALE');
  });

  it('picks the snapshot nearest the requested moment', () => {
    const near = snap('2026-06-14T16:00:00Z', 'near');
    const far = snap('2026-06-10T16:00:00Z', 'far');
    const out = selectRate([far, near], 'USD', 'NGN', new Date('2026-06-15T00:00:00Z'), DAY);
    expect(out).toMatchObject({ state: 'RATE_AVAILABLE', snapshot: { id: 'near' } });
  });

  it('no snapshot for the pair is RATE_UNAVAILABLE, never a null', () => {
    const wrongPair = { ...snap('2026-06-15T00:00:00Z'), quoteCurrency: 'GHS' };
    const out = selectRate([wrongPair], 'USD', 'NGN', new Date('2026-06-15T00:00:00Z'), DAY);
    expect(out.state).toBe('RATE_UNAVAILABLE');
  });

  it('a stale answer still names the nearest snapshot, so the refusal can explain itself', () => {
    const old = snap('2026-05-01T00:00:00Z');
    const out = selectRate([old], 'USD', 'NGN', new Date('2026-06-15T00:00:00Z'), DAY);
    expect(out.state).toBe('RATE_STALE');
    if (out.state === 'RATE_STALE') expect(out.distanceMs).toBeGreaterThan(DAY);
  });
});
