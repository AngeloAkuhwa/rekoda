/**
 * OD-40: the provider payment time is read only from a full, zoned ISO 8601 instant. Anything
 * else is null, never a guess in the server's own zone.
 */
import { describe, expect, it } from 'vitest';
import { instantOf } from './process-billing-charge.handler.js';

describe('instantOf (OD-40 provider payment time)', () => {
  it.each([
    ['2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z'],
    ['2026-08-19T12:00:00Z', '2026-08-19T12:00:00.000Z'],
    ['2026-08-19T13:00:00.000+01:00', '2026-08-19T12:00:00.000Z'],
    ['2026-08-19T13:00:00+0100', '2026-08-19T12:00:00.000Z'],
    ['2026-12-31T23:30:00.000-01:00', '2027-01-01T00:30:00.000Z'],
  ])('reads %s as the instant %s', (iso, expected) => {
    expect(instantOf(iso)?.toISOString()).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    'yesterday afternoon',
    '2026-08-19',
    '2026-08-19T12:00:00',
    '2026-08-19 12:00:00Z',
    '2026-13-40T99:00:00Z',
    '2026-02-30T12:00:00Z',
    '2026-04-31T12:00:00.000Z',
    '2026-08-19T24:00:00Z',
    '2026-08-19T12:60:00Z',
    '2026-08-19T12:00:00+15:00',
    '2026-08-19T12:00:00+01:75',
  ])('answers null for %s', (iso) => {
    expect(instantOf(iso)).toBeNull();
  });
});
