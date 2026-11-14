/**
 * G-119 / OWN-77: a staging fault lookup that fails happens before any provider call, so the
 * sweep must hear "definitely not sent, transient" and retry, never "outcome unknown".
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '@rekoda/db';
import { applyStagingFault } from './staging-faults.js';
import { SendFailed } from '../channels/sender.js';

const BUSINESS = '00000000-0000-4000-8000-000000000001';
const failing = {
  transaction: () => Promise.reject(new Error('connection terminated')),
} as unknown as Db;

describe('applyStagingFault', () => {
  it('touches nothing when the deployment flag is off', async () => {
    await expect(applyStagingFault(failing, BUSINESS, false)).resolves.toBeUndefined();
    await expect(applyStagingFault(failing, BUSINESS, undefined)).resolves.toBeUndefined();
  });

  it('classifies a failed lookup as not sent and transient, not sender-wide', async () => {
    const error = await applyStagingFault(failing, BUSINESS, true).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SendFailed);
    expect(error).toMatchObject({ notSent: true, transient: true, outage: false });
  });
});
