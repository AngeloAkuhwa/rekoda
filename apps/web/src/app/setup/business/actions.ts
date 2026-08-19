'use server';

import { redirect } from 'next/navigation';
import { markSetupComplete, readVerifiedPhone } from '@/server/verified-phone';

export interface FormState {
  /** Per field — one shared slot put the type error under the name input. */
  errors?: { name?: string; type?: string };
}

const TYPES = new Set([
  'Fashion & clothing',
  'Beauty & cosmetics',
  'Food & drinks',
  'Electronics & phones',
  'Pharmacy & health',
  'Provisions & groceries',
  'Services & freelance',
  'Wholesale & trading',
  'Something else',
]);

/**
 * CAC/TIN is deliberately absent. Capture it later if the merchant offers it;
 * it must never block an informal merchant (spec §20, ADR 0012).
 */
export async function createBusiness(_prev: FormState, formData: FormData): Promise<FormState> {
  // Re-checked server-side: a form post must not bypass the guard either.
  const phone = await readVerifiedPhone();
  if (!phone) redirect('/start');

  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? '').trim();

  const errors: { name?: string; type?: string } = {};
  if (name.length < 2) errors.name = 'Give your business a name — whatever you call it is fine.';
  else if (name.length > 80) errors.name = 'That name is too long. 80 characters or fewer.';
  if (!TYPES.has(type)) errors.type = 'Pick the closest match. You can change it later.';
  if (Object.keys(errors).length > 0) return { errors };

  // TODO(M1): create Business, BusinessOwner, VerifiedPhone, BusinessMembership,
  // BusinessSettings in one transaction (spec §12 step 5), then exchange the
  // verification cookie for a real session. Blocked on apps/api + Postgres.
  //
  // Downgrade the marker: the completion page still renders, but full
  // proof-of-identity does not linger for the rest of the 30-minute window.
  await markSetupComplete(phone);
  redirect(`/setup/complete?name=${encodeURIComponent(name)}`);
}
