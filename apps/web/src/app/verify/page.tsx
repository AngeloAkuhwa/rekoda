import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import { VerifyForm } from './VerifyForm';

export const metadata: Metadata = {
  title: 'Confirm your number',
  robots: { index: false, follow: false },
};

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const { phone } = await searchParams;
  if (!phone) redirect('/start');
  // Normalise before display AND before it round-trips through the form, so the
  // lookup key can never diverge from the one startOtp wrote.
  try {
    return <VerifyForm phone={normalisePhone(phone)} />;
  } catch (e) {
    if (e instanceof InvalidPhoneError) redirect('/start');
    throw e;
  }
}
