/**
 * Creating a test customer the way production does: a customer token is three random characters, so
 * two in one business can collide (about one in 46,000), and the repository answers
 * `TokenCollision`. The privacy gateway retries with a fresh token; so does this fixture. Without
 * it the customers suite failed CI once on `token CUSTOMER_7CJ is already in use`.
 */
import { generateCustomerToken } from '@rekoda/core/privacy';
import type { Db } from '../client.js';
import { customersRepo } from '../index.js';

const random = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));

export async function createCustomerRetrying(
  db: Db,
  businessId: string,
  identities: Parameters<typeof customersRepo.createCustomerWithIdentities>[3],
): Promise<customersRepo.CustomerRow> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await customersRepo.createCustomerWithIdentities(
        db,
        businessId,
        generateCustomerToken(random),
        identities,
      );
    } catch (error) {
      if (!(error instanceof customersRepo.TokenCollision) || attempt >= 5) throw error;
    }
  }
}
