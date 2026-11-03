import { describe, expect, it } from 'vitest';

import { createReminderBatchRequest } from './reports-api.js';

const base = {
  invoiceNumbers: ['INV-2026-000001'],
  channels: 'auto' as const,
  idempotencyKey: '6c0e7f1a-2b3d-4c5e-8f90-a1b2c3d4e5f6',
  confirm: true as const,
};

describe('createReminderBatchRequest replayOnly', () => {
  it('is optional, so an older web build still creates batches', () => {
    expect(createReminderBatchRequest.parse(base).replayOnly).toBeUndefined();
  });

  it('carries a replay-only retry, and refuses a value that is not a boolean', () => {
    expect(createReminderBatchRequest.parse({ ...base, replayOnly: true }).replayOnly).toBe(true);
    expect(() => createReminderBatchRequest.parse({ ...base, replayOnly: 'yes' })).toThrow();
  });
});
