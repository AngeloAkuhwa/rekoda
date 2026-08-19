import styles from './MoneyBadge.module.css';

/**
 * ADR 0014 — three states, never two. The negative answer is the product.
 *
 *   verified  provider-confirmed. Quiet affirmative, never celebratory.
 *   recorded  the merchant told us. NEUTRAL — cash and transfers are normal.
 *   notSeen   we have not observed it. NEVER styled as a failure; most of the
 *             time the transfer is simply still in flight.
 *
 * `attention` is reserved for genuine mismatches only. A queue that flags every
 * cash sale trains merchants to ignore the badge within a week.
 */
export type PaymentState = 'verified' | 'recorded' | 'notSeen' | 'attention';

const LABEL: Record<PaymentState, string> = {
  verified: 'Payment verified',
  recorded: 'Payment recorded',
  notSeen: 'Not seen yet',
  attention: 'Needs attention',
};

/** Shape as well as colour — never colour alone to convey meaning (P10).
 * `notSeen` is an ellipsis, not a dash: it reads "still in flight", where a
 * bare dash reads "zero" or "broken". */
const GLYPH: Record<PaymentState, string> = {
  verified: '✓',
  recorded: '•',
  notSeen: '…',
  attention: '!',
};

export function MoneyBadge({
  state,
  children,
}: {
  state: PaymentState;
  children?: React.ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${styles[state]}`}>
      <span aria-hidden="true" className={styles.glyph}>
        {GLYPH[state]}
      </span>
      {children ?? LABEL[state]}
    </span>
  );
}
