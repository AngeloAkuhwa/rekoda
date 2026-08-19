import type { Metadata } from 'next';
import { StartForm } from './StartForm';

export const metadata: Metadata = {
  title: 'Start Rekoda',
  description: 'Start Rekoda with your WhatsApp number. No password, no card.',
  robots: { index: false, follow: false },
};

export default function StartPage() {
  return <StartForm />;
}
