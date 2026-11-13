/**
 * Create a customer the way the privacy gateway does: a candidate token, and a fresh candidate
 * when the business already holds that one (`apps/api/src/privacy/gateway.service.ts`).
 *
 * A token is three characters, 32,768 per business, so two random tokens in one test collide
 * about once in 32,768 runs. Calling the repository directly turned that into a CI flake
 * (`token CUSTOMER_7CJ is already in use`, 13 Nov 2026).
 */
import { generateCustomerToken } from '@rekoda/core/privacy';
import type { Db } from '../client.js';
import { customersRepo } from '../index.js';

type Identities = Parameters<typeof customersRepo.createCustomerWithIdentities>[3];

const random = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));

export async function createCustomer(
  db: Db,
  businessId: string,
  identities: Identities,
  nextToken: () => string = () => generateCustomerToken(random),
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await customersRepo.createCustomerWithIdentities(
        db,
        businessId,
        nextToken(),
        identities,
      );
    } catch (error) {
      if (!(error instanceof customersRepo.TokenCollision) || attempt >= 5) throw error;
    }
  }
}
