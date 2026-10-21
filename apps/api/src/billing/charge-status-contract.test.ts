import type { BillingChargeStatus } from '@rekoda/contracts';
import type { subscriptionsRepo } from '@rekoda/db';
import { describe, expectTypeOf, it } from 'vitest';

/* The page translates the contract's list of charge statuses; the writer and the
   database CHECK (migration 0020) own the real one. This is a compile-time pin:
   if either gains or loses a status the other does not, typecheck fails here
   (G-69), instead of the page failing to parse a charge at runtime. */
describe('the charge status contract (G-69)', () => {
  it('lists exactly the statuses the database writer can produce', () => {
    expectTypeOf<BillingChargeStatus>().toEqualTypeOf<subscriptionsRepo.ChargeStatus>();
  });
});
