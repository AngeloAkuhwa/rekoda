import { randomBytes } from 'node:crypto';

/**
 * Where a product photo lives in the bucket.
 *
 * Same shape and same reasoning as `documentKey`: the business prefix is for
 * operations, expiring one shop's objects or answering an erasure request,
 * and it is NOT what makes the key secret. That is the 128 random bits after
 * it. A derivable key would let anyone holding one photo's URL walk a shop's
 * whole catalogue by counting.
 *
 * Its own function rather than `documentKey` with a different `kind`, because
 * these two live under different prefixes on purpose: documents are a
 * merchant's financial records and fall under the retention schedule, and a
 * product photo is neither. A sweep that deleted the wrong one because they
 * shared a namespace is not a mistake worth leaving available.
 */
export function productImageKey(businessId: string, extension: string): string {
  return `catalogue/${businessId}/${randomBytes(16).toString('hex')}.${extension}`;
}
