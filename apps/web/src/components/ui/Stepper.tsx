import styles from './Stepper.module.css';

/** Real progress, not decoration — the Chat path must feel like ≤90 seconds. */
const STEPS = ['Your number', 'Confirm', 'Your business', 'Done'] as const;

export function Stepper({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <nav aria-label="Progress" className={styles.wrap}>
      <ol className={styles.list}>
        {STEPS.map((label, i) => {
          const n = i + 1;
          const state = n < current ? 'done' : n === current ? 'current' : 'todo';
          return (
            <li
              key={label}
              className={`${styles.step} ${styles[state]}`}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className={styles.dot} aria-hidden="true">
                {state === 'done' ? '✓' : n}
              </span>
              <span className={styles.label}>{label}</span>
            </li>
          );
        })}
      </ol>
      <p className="rk-sr-only">
        Step {current} of {STEPS.length}: {STEPS[current - 1]}
      </p>
    </nav>
  );
}
