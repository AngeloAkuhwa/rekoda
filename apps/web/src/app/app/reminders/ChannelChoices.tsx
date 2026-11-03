'use client';

import type { ChannelChoice } from '@/lib/reminder-copy';
import styles from './reminders.module.css';

const OPTIONS: Array<{ value: ChannelChoice; label: string; sub: string }> = [
  {
    value: 'auto',
    label: 'WhatsApp, and email where you have an address',
    sub: 'Each channel is checked on its own.',
  },
  { value: 'whatsapp', label: 'WhatsApp only', sub: 'No email is sent.' },
  { value: 'email', label: 'Email only', sub: 'No WhatsApp message is sent.' },
  { value: 'both', label: 'Both WhatsApp and email', sub: 'Tries each one.' },
];

/** How a reminder goes out. The same four choices for one invoice and for many. */
export function ChannelChoices({
  name,
  value,
  onChange,
  idPrefix,
}: {
  name: string;
  value: ChannelChoice;
  onChange: (choice: ChannelChoice) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className={styles.group}>
      <legend>How to send</legend>
      <div className={styles.choices}>
        {OPTIONS.map((o) => (
          <label key={o.value} className={styles.choice} htmlFor={`${idPrefix}-${o.value}`}>
            <input
              id={`${idPrefix}-${o.value}`}
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span className={styles.choiceText}>
              {o.label}
              <span className={styles.choiceSub}>{o.sub}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
