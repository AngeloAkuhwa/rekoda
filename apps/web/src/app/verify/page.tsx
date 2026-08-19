import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import { firstParam } from '@/lib/search-params';
import { readDevCode } from '@/server/dev-otp';
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

  // Normalised for DISPLAY only. This page guards nothing — the code is checked
  // by the API against a row in Postgres, so a hand-typed number here buys an
  // attacker exactly one thing: a form they cannot complete.
  let normalised: string;
  try {
    normalised = normalisePhone(phone);
  } catch (e) {
    // Anything unparseable — including a repeated param — is a redirect, never
    // a 500. Only genuinely unexpected errors propagate.
    if (e instanceof InvalidPhoneError) redirect('/start');
    throw e;
  }

  // undefined unless REKODA_E2E_REVEAL_OTP=1 — see the note in dev-otp.
  return <VerifyForm phone={normalised} e2eCode={await readDevCode()} />;
}
