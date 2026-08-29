import { RETENTION } from '@rekoda/core';

/**
 * Facts that belong to the company rather than the code.
 *
 * A legal page must never invent a registered name, an address or a contact
 * route — a policy that names the wrong entity is worse than no policy, and
 * placeholder text like "Company Name Ltd" has a way of surviving to
 * production. So every such value comes from the environment, and anything
 * unset renders as a visible badge saying so, rather than as blank space or a
 * plausible-looking lie.
 *
 * The badge is a development affordance, not a production state: a
 * production server refuses to start without the mandatory values
 * (`legal-gate.mjs`, wired into `next.config.mjs` — remediation R8), so the
 * only place a badge can render is an environment where it is telling a
 * developer the truth.
 *
 * See MASTER-PLAN §5.2.4.
 */
export interface LegalFact {
  label: string;
  value: string | null;
}

const fact = (label: string, value: string | undefined): LegalFact => ({
  label,
  value: value && value.trim() ? value.trim() : null,
});

export const LEGAL = {
  entity: fact('Registered entity', process.env.NEXT_PUBLIC_LEGAL_ENTITY),
  rcNumber: fact('RC number', process.env.NEXT_PUBLIC_LEGAL_RC_NUMBER),
  address: fact('Registered address', process.env.NEXT_PUBLIC_LEGAL_ADDRESS),
  privacyEmail: fact('Privacy contact', process.env.NEXT_PUBLIC_PRIVACY_EMAIL),
  supportEmail: fact('Support contact', process.env.NEXT_PUBLIC_SUPPORT_EMAIL),
  ndprAuditor: fact('NDPR audit filing', process.env.NEXT_PUBLIC_NDPR_AUDITOR),
} as const;

/**
 * The date the policy text last changed. Deliberately a build-time constant
 * rather than `new Date()` — a policy page that claims to have been updated
 * today, every day, tells the reader nothing and quietly erases the real
 * revision history.
 */
export const POLICY_LAST_UPDATED = '19 August 2026';

/** Retention that survives an erasure request, and the law that requires it. */
export const FINANCIAL_RETENTION_YEARS = RETENTION.financialYears;

/**
 * The retention schedule (ADR 0024), re-exported from core.
 *
 * The numbers themselves live in `@rekoda/core/retention` because two things
 * must agree about them: this page, which promises a merchant a period, and
 * the sweep that enforces it. Two copies of a retention period is one page
 * telling a merchant something the database does not do.
 */
export { RETENTION };
