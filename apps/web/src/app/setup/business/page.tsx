import type { Metadata } from 'next';
import { requireSetupGrant } from '@/server/guards';
import { BusinessForm } from './BusinessForm';

export const metadata: Metadata = {
  title: 'Your business',
  robots: { index: false, follow: false },
};

export default async function BusinessPage() {
  // Not "is a cookie present" — the API is asked whether the grant is real.
  // A forged or expired value redirects instead of rendering the form.
  const { state } = await requireSetupGrant();
  return <BusinessForm phone={state.phone} />;
}
