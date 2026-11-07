/**
 * The WhatsApp template slots Rekoda sends through, in one place (OD-41(b)).
 *
 * Five application message types go out as Meta templates on Rekoda's own number, because each
 * can reach a phone that has not written in the last 24 hours, where Meta rejects free-form text
 * (131047). This table is the authority for:
 *
 *   - which environment variables name each template and its language (`config.ts` reads them),
 *   - the template name agreed with the owner for each slot (the templates already exist in Meta;
 *     the repository never creates or approves one),
 *   - whether a slot is REQUIRED for a staging or production deployment to be ready, or OPTIONAL,
 *   - the parameters the sender puts on the wire, in order (`meta.sender.ts` builds exactly these).
 *
 * `scripts/staging-readonly-check.sh` carries the same list in bash; its test reads this file and
 * fails if the two disagree. Nothing here knows whether Meta approved a template: approval, quality
 * and active status are checked by hand in WhatsApp Manager (docs/runbooks/meta-whatsapp-templates.md).
 *
 * Required versus optional (engineering classification, recorded in the PR A plan): a slot is
 * required when leaving it unset stops a launch journey from reaching the merchant at all (sign-in,
 * grace reminders, document-ready notices, trial reminders). The retention slot is optional: with
 * it unset the retention sweep warns nobody and therefore deletes nobody (`retention-sweep.ts`),
 * which fails safe.
 */

/** One body (or button) parameter, by meaning. All are sent as Meta `text` parameters. */
export type TemplateParameter =
  'code' | 'daysLeft' | 'endsOn' | 'deletesOn' | 'billingUrl' | 'documentLabel' | 'reference';

export interface TemplateSlot {
  /** Short name used in logs, cost records and the staging check. */
  slot: 'otp' | 'billing' | 'retention' | 'document' | 'trial';
  /** The environment variable naming the Meta template. */
  env: string;
  /** The environment variable naming its language code; `DEFAULT_TEMPLATE_LOCALE` when unset. */
  localeEnv: string;
  /** The template name agreed with the owner (OD-41(b), 7 Nov 2026). */
  agreedName: string;
  /** The language agreed with the owner, where one was stated; null means "confirm in Meta". */
  agreedLocale: string | null;
  /** Meta's category for the template, as the code relies on it. */
  category: 'AUTHENTICATION' | 'UTILITY';
  required: boolean;
  /** What the message is for, and which code sends it. */
  purpose: string;
  /** Body parameters in order: `{{1}}`, `{{2}}`, ... */
  body: readonly TemplateParameter[];
  /** A URL button's single parameter, when the template has one. */
  button: TemplateParameter | null;
}

export const DEFAULT_TEMPLATE_LOCALE = 'en';

export const TEMPLATE_SLOTS: readonly TemplateSlot[] = [
  {
    slot: 'otp',
    env: 'META_OTP_TEMPLATE',
    localeEnv: 'META_OTP_TEMPLATE_LOCALE',
    agreedName: 'rekoda_login_otp',
    agreedLocale: null,
    category: 'AUTHENTICATION',
    required: true,
    purpose: 'sign-in code (sendAuthCode, auth/auth.service.ts)',
    body: ['code'],
    button: 'code',
  },
  {
    slot: 'billing',
    env: 'META_BILLING_TEMPLATE',
    localeEnv: 'META_BILLING_TEMPLATE_LOCALE',
    agreedName: 'rekoda_billing_grace_notice',
    agreedLocale: null,
    category: 'UTILITY',
    required: true,
    purpose:
      'grace-period reminder after a failed renewal (sendBillingNotice, billing/grace-sweep.ts)',
    body: ['daysLeft', 'endsOn', 'billingUrl'],
    button: null,
  },
  {
    slot: 'retention',
    env: 'META_RETENTION_TEMPLATE',
    localeEnv: 'META_RETENTION_TEMPLATE_LOCALE',
    agreedName: 'rekoda_retention_notice',
    agreedLocale: null,
    category: 'UTILITY',
    required: false,
    purpose:
      'warning before an abandoned trial is deleted (sendRetentionNotice, privacy/retention-sweep.ts)',
    body: ['daysLeft', 'deletesOn'],
    button: null,
  },
  {
    slot: 'document',
    env: 'META_DOCUMENT_TEMPLATE',
    localeEnv: 'META_DOCUMENT_TEMPLATE_LOCALE',
    agreedName: 'rekoda_document_ready',
    agreedLocale: null,
    category: 'UTILITY',
    required: true,
    purpose:
      '"your document is ready" outside the 24-hour window (sendDocumentNotice, jobs/deliver-document.handler.ts)',
    body: ['documentLabel', 'reference'],
    button: null,
  },
  {
    slot: 'trial',
    env: 'META_TRIAL_TEMPLATE',
    localeEnv: 'META_TRIAL_TEMPLATE_LOCALE',
    agreedName: 'rekoda_trial_ending',
    agreedLocale: 'en',
    category: 'UTILITY',
    required: true,
    purpose:
      'trial reminder 7, 2 and 1 days before the trial ends (sendTrialNotice, billing/trial-notice-sweep.ts)',
    body: ['daysLeft', 'endsOn', 'billingUrl'],
    button: null,
  },
];

/**
 * Meta template names are lowercase letters, digits and underscores (WhatsApp Manager refuses
 * anything else), at most 512 characters.
 */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

/** A Meta language code: `en`, `fr`, `en_US`, `pt_BR`, `ha` and similar. */
const TEMPLATE_LOCALE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

export interface TemplateConfigProblem {
  env: string;
  problem: string;
}

/**
 * What is wrong with the template settings, without printing any value. A value that is set but
 * malformed is always a problem: sending through it would be refused by Meta every time, which
 * looks like an approval problem rather than a typo. Empty means unset (the sender then refuses
 * that message type as not sent, never as free text).
 */
export function templateConfigProblems(env: NodeJS.ProcessEnv): TemplateConfigProblem[] {
  const problems: TemplateConfigProblem[] = [];
  for (const slot of TEMPLATE_SLOTS) {
    const name = env[slot.env];
    if (name !== undefined && name !== '' && !TEMPLATE_NAME.test(name)) {
      problems.push({
        env: slot.env,
        problem: 'must be a Meta template name (lowercase letters, digits and underscores)',
      });
    }
    // Empty is unset (the default, en), as for the template name: a copied .env.example boots.
    const locale = env[slot.localeEnv];
    if (locale !== undefined && locale !== '' && !TEMPLATE_LOCALE.test(locale)) {
      problems.push({
        env: slot.localeEnv,
        problem: 'must be a Meta language code such as en or en_US',
      });
    }
  }
  return problems;
}

/** The slots whose template variable is unset or empty. */
export function missingTemplateSlots(env: NodeJS.ProcessEnv): TemplateSlot[] {
  return TEMPLATE_SLOTS.filter((s) => !env[s.env]);
}

/**
 * The merchant's billing page, built from `REKODA_WEB_URL` (the dashboard's origin for this
 * environment: `https://staging.myrekoda.com` on staging). Null when there is no usable origin,
 * in which case a template that carries the link cannot be sent and is refused as not sent.
 */
export function billingPageUrl(webUrl: string | null): string | null {
  if (!webUrl) return null;
  try {
    const origin = new URL(webUrl);
    /* A link goes to a merchant's phone and into Meta: never one that carries credentials, and
     * only the origin is used, so no path, query or fragment of the setting is copied. */
    if (origin.username !== '' || origin.password !== '') return null;
    return new URL('/app/billing', origin.origin).toString();
  } catch {
    return null;
  }
}
