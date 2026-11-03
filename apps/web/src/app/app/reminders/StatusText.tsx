import styles from './reminders.module.css';

/** A status in words, its tone repeated in colour (never colour alone). */
export function StatusText({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={styles.status} data-tone={tone}>
      {label}
    </span>
  );
}
