import type { Metadata } from 'next';
import { firstParam } from '@/lib/search-params';
import { StartForm } from './StartForm';

export const metadata: Metadata = {
  title: 'Start Rekoda',
  description: 'Start Rekoda with your WhatsApp number. No password, no card.',
  robots: { index: false, follow: false },
};

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string | string[]; plan?: string | string[] }>;
}) {
  const params = await searchParams;
  /* "Not your number?" on /verify comes back here carrying what was typed,
   * so a mistake costs one edit rather than a blank field. The plan a
   * pricing button named is echoed as a sentence: the 30-day trial is the
   * same either way, and pretending the click configured something would be
   * a lie with a reassuring shape. */
  return <StartForm initialPhone={firstParam(params.phone) ?? ''} plan={firstParam(params.plan)} />;
}
