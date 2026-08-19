import type { LegalFact } from '@/lib/legal';

/**
 * Renders a company fact, or says plainly that it is not set yet.
 *
 * The badge is the point. An unconfigured legal page should LOOK
 * unconfigured — silently rendering an empty string is how a policy goes live
 * naming nobody, and a plausible placeholder is how one goes live naming the
 * wrong body.
 */
export function Fact({ fact }: { fact: LegalFact }) {
  if (!fact.value) {
    return (
      <span className="rk-unset" role="note">
        {fact.label} not set yet
      </span>
    );
  }
  return <>{fact.value}</>;
}
