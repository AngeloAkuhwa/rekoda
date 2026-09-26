/**
 * The event identity of a public API sale (G-77).
 */
import { describe, expect, it } from 'vitest';
import { apiSaleEventId } from './sale-event-id.js';

const APP_A = '3f8a1c2e-0b4d-4e6f-9a1b-2c3d4e5f6a7b';
const APP_B = '9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e';

describe('apiSaleEventId', () => {
  it('is the same for the same application and Idempotency-Key, so a retry replays', () => {
    expect(apiSaleEventId(APP_A, 'sale-a')).toBe(apiSaleEventId(APP_A, 'sale-a'));
  });

  it('differs for distinct keys, and for the same key from another application', () => {
    expect(apiSaleEventId(APP_A, 'sale-a')).not.toBe(apiSaleEventId(APP_A, 'sale-b'));
    expect(apiSaleEventId(APP_A, 'sale-a')).not.toBe(apiSaleEventId(APP_B, 'sale-a'));
  });

  it('is fresh for every request without a key', () => {
    expect(apiSaleEventId(APP_A, null)).not.toBe(apiSaleEventId(APP_A, null));
    expect(apiSaleEventId(APP_A, '')).not.toBe(apiSaleEventId(APP_A, ''));
  });

  it('never carries the application id or the caller key, and stays bounded', () => {
    const key = 'order-2026-000123-with-a-long-caller-chosen-key'.repeat(8);
    for (const id of [apiSaleEventId(APP_A, key), apiSaleEventId(APP_A, null)]) {
      expect(id).not.toContain(APP_A);
      expect(id).not.toContain('order-2026');
      expect(id.length).toBeLessThanOrEqual(64);
      expect(id).toMatch(/^sale-[0-9a-z-]+$/);
    }
  });
});
