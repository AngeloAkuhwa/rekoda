'use server';

import {
  publicOrderRequest,
  type PublicOrderResponse,
  payWithTransferRequest,
  type PayWithTransferResponse,
  type TransferStatusResponse,
} from '@rekoda/contracts';
import { placePublicOrder, payWithTransfer, transferStatus } from '@/server/api';

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

/**
 * Ask for a temporary transfer account for a placed order (fix-plan 6,
 * M5c). The email exists because the payment provider requires one; it
 * travels there and Rekoda does not keep it.
 */
export async function requestTransferAccount(
  slug: string,
  payload: unknown,
): Promise<PayWithTransferResponse | null> {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 80) return null;
  const parsed = payWithTransferRequest.safeParse(payload);
  if (!parsed.success) return null;
  return payWithTransfer(slug, parsed.data);
}

/** "I have sent it" — starts a server-side verify, never takes their word. */
export async function checkTransferStatus(
  slug: string,
  clientRef: unknown,
): Promise<TransferStatusResponse | null> {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 80) return null;
  if (typeof clientRef !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientRef)) return null;
  return transferStatus(slug, clientRef);
}
