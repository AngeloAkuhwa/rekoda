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
export const FINANCIAL_RETENTION_YEARS = 6;

/**
 * The retention schedule (ADR 0024).
 *
 * ADR 0024 promised merchants access "under a published retention schedule"
 * rather than indefinitely, for a reason worth restating: Nigerian tax
 * administration expects business books to be kept for a period after the
 * relevant year of assessment, while the NDP Act's storage-limitation
 * principle says personal data should not outlive its purpose. "Forever"
 * satisfies the first and violates the second, so a number had to be chosen
 * for each kind of record.
 *
 * These are the numbers. They live here rather than in prose so that no page
 * can state a period the others contradict.
 *
 * They are MAXIMUMS, and a maximum is a promise about a date. The sweep that
 * enforces them does not exist yet, and the shortest period here is 90 days:
 * that is the deadline, counted from the first merchant who abandons a trial,
 * not a someday. A published schedule nothing enforces becomes a lie on a
 * specific day rather than gradually.
 */
export const RETENTION = {
  /** Books, after the year of assessment they belong to. Tax law's floor. */
  financialYears: FINANCIAL_RETENTION_YEARS,
  /** A trial that was never converted, after it ends. Warned before deletion. */
  abandonedTrialDays: 90,
  /** Chat history and drafts, after an account closes. Not financial records. */
  conversationDays: 90,
  /** Voice notes. Deleted after transcription, never stored as audio. */
  voiceNoteDays: 0,
  /** Warning before anything is deleted on this schedule. */
  noticeDays: 30,
} as const;
