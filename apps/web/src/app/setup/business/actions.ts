'use server';

import { redirect } from 'next/navigation';

export interface FormState {
  error?: string;
}

/**
 * CAC/TIN is deliberately absent. Capture it later if the merchant offers it;
 * it must never block an informal merchant from creating a business
 * (spec §20, ADR 0012).
 */
export async function createBusiness(_prev: FormState, formData: FormData): Promise<FormState> {
  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? '').trim();

  if (name.length < 2)
    return { error: 'Give your business a name — whatever you call it is fine.' };
  if (name.length > 80) return { error: 'That name is too long. 80 characters or fewer.' };
  if (!type) return { error: 'Pick the closest match. You can change it later.' };

  // TODO(M1): create Business, BusinessOwner, VerifiedPhone, BusinessMembership,
  // BusinessSettings inside one transaction (spec §12 step 5), then issue a
  // session cookie. Blocked on apps/api + Postgres.
  redirect(`/setup/complete?name=${encodeURIComponent(name)}`);
}
