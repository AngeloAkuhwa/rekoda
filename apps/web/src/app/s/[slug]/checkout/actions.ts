'use server';

import { publicOrderRequest, type PublicOrderResponse } from '@rekoda/contracts';
import { placePublicOrder } from '@/server/api';

/**
 * The checkout's one server action (fix-plan 6, M5b). No session and no
 * cookie: the caller is a customer. The payload is re-parsed against the
 * same contract the API enforces, so a tampered submission dies here as a
 * null rather than travelling; and there are no prices in it to tamper
 * with anyway, because the API prices every line from the catalogue.
 */
export async function submitStorefrontOrder(
  slug: string,
  payload: unknown,
): Promise<PublicOrderResponse | null> {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 80) return null;
  const parsed = publicOrderRequest.safeParse(payload);
  if (!parsed.success) return null;
  return placePublicOrder(slug, parsed.data);
}
