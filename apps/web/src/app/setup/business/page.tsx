import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BusinessForm } from './BusinessForm';

export const metadata: Metadata = {
  title: 'Your business',
  robots: { index: false, follow: false },
};

export default async function BusinessPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const { phone } = await searchParams;
  if (!phone) redirect('/start');
  return <BusinessForm phone={phone} />;
}
