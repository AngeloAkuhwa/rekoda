import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
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
  return <VerifyForm phone={phone} />;
}
