'use server';

import { redirect } from 'next/navigation';
import { ApiUnauthorised, ApiUnavailable, createBusiness } from '@/server/api';
import { clearSetupToken, readSetupToken, setSessionToken } from '@/server/session-cookies';

export interface FormState {
  /** Per field — one shared slot put the type error under the name input. */
  errors?: { name?: string; type?: string; form?: string };
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
 * CAC and TIN are deliberately absent, and must stay absent.
 *
 * Most WhatsApp vendors have neither. Requiring either would exclude exactly
 * the merchants Rekoda exists for (spec §20, ADR 0012) — capture them later
 * from settings, if the merchant offers them.
 */
export async function createBusinessAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  // Re-checked server-side: a form post must not bypass the page guard either.
  const setupToken = await readSetupToken();
  if (!setupToken) redirect('/start');

  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? '').trim();

  const errors: { name?: string; type?: string } = {};
  if (name.length < 2) errors.name = 'Give your business a name — whatever you call it is fine.';
  else if (name.length > 80) errors.name = 'That name is too long. 80 characters or fewer.';
  if (!TYPES.has(type)) errors.type = 'Pick the closest match. You can change it later.';
  if (Object.keys(errors).length > 0) return { errors };

  let session;
  try {
    session = await createBusiness(setupToken, { name, businessType: type });
  } catch (error) {
    if (error instanceof ApiUnauthorised) redirect('/start');
    if (error instanceof ApiUnavailable) {
      return { errors: { form: 'We could not reach Rekoda just now. Try again in a moment.' } };
    }
    throw error;
  }

  // The grant has done its one job; a session now carries identity. Leaving it
  // live would keep a second, weaker credential valid for the next half hour.
  await clearSetupToken();
  await setSessionToken(session.sessionToken);
  redirect('/setup/complete');
}
