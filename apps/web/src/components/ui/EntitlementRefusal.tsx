import type { CapabilityRefusal } from '@rekoda/core';
import styles from './EntitlementRefusal.module.css';

/**
 * What a merchant is told when they reach something their plan does not
 * carry (design system §4, spec §4.5).
 *
 * Three things, in this order: what is unavailable, why, and which plan would
 * change it. A refusal missing the third is a dead end; a refusal missing the
 * second reads as a fault.
 *
 * It appears where somebody ARRIVED at the thing: a deep link, a bookmark,
 * an explicit attempt. It is deliberately not a permanent rail on the
 * dashboard, because a merchant who is paying for one product and is told
 * every morning about another has been sold to rather than served.
 *
 * The tone rule is the one the reply layer already follows: say what is still
 * true before saying what is not. A merchant on Integrate did pay us.
 */
export function EntitlementRefusal({
  refusal,
  action,
}: {
  refusal: CapabilityRefusal;
  /** Where "see the plans" goes. Defaults to the billing page. */
  action?: string;
}) {
  return (
    <section className={`rk-card ${styles.refusal}`} aria-labelledby="rk-refusal-title">
      <h2 id="rk-refusal-title" className={styles.title}>
        {sentenceCase(refusal.what)} is not part of your plan
      </h2>
      <p className={styles.why}>{refusal.why}</p>
      {refusal.availableOn.length > 0 ? (
        <p className={styles.where}>
          Available on {list(refusal.availableOn)}.{' '}
          <a href={action ?? '/app/billing'} className="rk-period-link">
            See the plans
          </a>
        </p>
      ) : null}
    </section>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "A and B", "A, B and C". Never an Oxford comma; merchants do not write one. */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
