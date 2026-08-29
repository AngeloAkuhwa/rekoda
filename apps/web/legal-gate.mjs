/**
 * Production gate on the company facts the legal pages render (remediation
 * R8).
 *
 * Every fact in `src/lib/legal.ts` that is unset renders as a visible
 * "not set yet" badge. That is the right behaviour in development — a badge
 * is honest where invented text would be a lie — and exactly the wrong thing
 * to serve to the public: a privacy policy whose registered entity is a
 * badge is not a policy. This gate makes that state unreachable in
 * production by refusing to START the server without the mandatory values.
 *
 * Where it runs matters. `next.config.mjs` is evaluated once per phase, so
 * the check fires at `phase-production-server` — before a single page is
 * served — and deliberately NOT at `phase-production-build`: CI builds the
 * site without the real CAC values, which are supplied to the deployment
 * environment separately and never committed. The deployment supplies the
 * same environment to build and serve, so a server that passes this gate
 * was also built with the values present.
 *
 * Plain .mjs rather than TypeScript because `next.config.mjs` must be able
 * to import it; `legal-gate.d.mts` carries the types for the unit tests.
 */

/**
 * The facts a public legal page cannot be served without. NDPR auditor is
 * deliberately absent: the filing happens on the regulator's schedule, not
 * the deploy's, and the page copes with it honestly ("not yet filed").
 */
export const MANDATORY_LEGAL_VARS = Object.freeze([
  'NEXT_PUBLIC_LEGAL_ENTITY',
  'NEXT_PUBLIC_LEGAL_RC_NUMBER',
  'NEXT_PUBLIC_LEGAL_ADDRESS',
  'NEXT_PUBLIC_PRIVACY_EMAIL',
  'NEXT_PUBLIC_SUPPORT_EMAIL',
]);

/**
 * The mandatory variables that are unset or blank in `env`.
 *
 * Whitespace counts as unset — `" "` produces the same badge an absent
 * value does, so it must fail the same way.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function missingLegalVars(env) {
  return MANDATORY_LEGAL_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
}

/**
 * Refuse to start a production server whose legal pages would render
 * placeholder badges.
 *
 * @param {string} phase - the Next.js phase constant this config load is for.
 * @param {Record<string, string | undefined>} env
 */
export function assertLegalIdentityConfigured(phase, env) {
  if (phase !== 'phase-production-server') return;
  const missing = missingLegalVars(env);
  if (missing.length === 0) return;
  throw new Error(
    'refusing to serve legal pages with placeholder company facts: ' +
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
      'Every public policy must name the real registered entity and real ' +
      'contact routes; set these in the deployment environment (they are ' +
      'provided by the owner, never committed) and start again.',
  );
}
