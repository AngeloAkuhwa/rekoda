import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import { firstParam } from '@/lib/search-params';
import { e2eCodeFor } from '@/server/onboarding-store';
import { VerifyForm } from './VerifyForm';

export const metadata: Metadata = {
  title: 'Confirm your number',
  robots: { index: false, follow: false },
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string | string[] }>;
}) {
  const phone = firstParam((await searchParams).phone);
  if (!phone) redirect('/start');

  // Normalise before display AND before it round-trips through the form, so the
  // lookup key can never diverge from the one startOtp wrote.
  let normalised: string;
  try {
    normalised = normalisePhone(phone);
  } catch (e) {
    // Anything unparseable — including a repeated param — is a redirect, never
    // a 500. Only genuinely unexpected errors propagate.
    if (e instanceof InvalidPhoneError) redirect('/start');
    throw e;
  }
  // undefined unless REKODA_E2E_REVEAL_OTP=1 — see the note in onboarding-store.
  return <VerifyForm phone={normalised} e2eCode={e2eCodeFor(normalised)} />;
}
