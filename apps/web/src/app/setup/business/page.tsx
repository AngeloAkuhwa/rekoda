import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { readVerifiedPhone } from '@/server/verified-phone';
import { BusinessForm } from './BusinessForm';

export const metadata: Metadata = {
  title: 'Your business',
  robots: { index: false, follow: false },
};

export default async function BusinessPage() {
  // Proof of OTP, not a query param. A URL alone must never reach this page.
  const phone = await readVerifiedPhone();
  if (!phone) redirect('/start');
  return <BusinessForm phone={phone} />;
}
