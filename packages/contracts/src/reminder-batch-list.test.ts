import { describe, expect, it } from 'vitest';

import { reminderBatchListResponse } from './reports-api';

describe('reminderBatchListResponse', () => {
  it('reads an older API answer with no released field as not released', () => {
    /* During a container replacement the new web can call the old API once. */
    expect(reminderBatchListResponse.parse({ batches: [] }).released).toBe(false);
  });

  it('still refuses a released value that is not a boolean', () => {
    expect(() => reminderBatchListResponse.parse({ batches: [], released: 'yes' })).toThrow();
  });
});
