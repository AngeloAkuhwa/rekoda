import { Children, cloneElement, isValidElement } from 'react';
import styles from './Field.module.css';

/**
 * Visible label always — placeholder-as-label fails the moment the user types
 * (ui-ux-pro-max P8).
 *
 * `aria-describedby` and `aria-invalid` are injected onto the child rather than
 * left to the caller. Trusting callers already failed once: the business-name
 * input shipped without them, so its hint and error were rendered but orphaned
 * from the input for screen-reader users.
 */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  const child = Children.only(children);
  const wired = isValidElement<Record<string, unknown>>(child)
    ? cloneElement(child, {
        id,
        'aria-describedby': describedBy,
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : child;

  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {wired}
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
