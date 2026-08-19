import styles from './Field.module.css';

/**
 * Visible label always — placeholder-as-label fails the moment the user types
 * (ui-ux-pro-max P8). Errors sit next to the field, in words, and are wired to
 * the input via aria-describedby so a screen reader hears them.
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
  /* Explicitly `| undefined`: the repo runs exactOptionalPropertyTypes, and a
     form field genuinely has "no error yet" as a state. */
  hint?: string | undefined;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
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
      {children}
      {error ? (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
