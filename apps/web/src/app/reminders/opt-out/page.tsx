import type { Metadata } from 'next';
import { OptOut } from './OptOut';

export const metadata: Metadata = {
  title: 'Stop payment reminders',
  // The link is private to its recipient: never indexed, never cached.
  robots: { index: false, follow: false },
};

/** `/reminders/opt-out#token=...`, opened from a payment reminder email (N1). No sign-in. */
export default function ReminderOptOutPage() {
  return (
    <section className="rk-container">
      <h1>Payment reminders</h1>
      <OptOut />
    </section>
  );
}
