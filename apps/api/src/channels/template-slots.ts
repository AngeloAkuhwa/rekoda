/**
 * The WhatsApp template slots Rekoda sends through, in one place (OD-41(b); OWN-93).
 *
 * Five application message types go out as Meta templates on Rekoda's own number, because each
 * can reach a phone that has not written in the last 24 hours, where Meta rejects free-form text
 * (131047). This table defines the MESSAGE CONTRACT of each slot, and nothing about the template
 * the owner created for it in WhatsApp Manager:
 *
 *   - which environment variables name the slot's template and its language (`config.ts` reads
 *     them through `configuredTemplates`; nothing else names a template or a language),
 *   - whether a slot is REQUIRED for a staging or production deployment to be ready, or OPTIONAL,
 *   - the parameters the sender puts on the wire, in order (`meta.sender.ts` builds exactly these).
 *
 * OWN-93 (14 Nov 2026): the environment is the single source of truth for every template name and
 * language. The repository holds no template name and no default language: a slot whose template
 * variable is unset is not configured (the sender refuses that message as not sent, never as free
 * text), and a template set without its language refuses to boot. Changing a template in WhatsApp
 * Manager is a change to `.env` and a restart, never a code change.
 *
 * `scripts/staging-readonly-check.sh` holds no copy of this table: it runs `dist/template-check.js`
 * (`template-check.ts`) inside each running container, which classifies that container's own
 * settings with the functions below. Nothing here knows whether Meta approved a template: approval,
 * quality and active status are checked by hand in WhatsApp Manager
 * (docs/runbooks/meta-whatsapp-templates.md).
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

export type TemplateSlotId = 'otp' | 'billing' | 'retention' | 'document' | 'trial';

export interface TemplateSlot {
  /** Short name used in logs, cost records and the staging check. */
  slot: TemplateSlotId;
  /** The environment variable naming the Meta template. */
  env: string;
  /** The environment variable naming its language code; required whenever `env` is set. */
  localeEnv: string;
  /**
   * The category the message contract is written for, and the one Rekoda's cost record prices the
   * send at (`UTILITY_TEMPLATE`, or the authentication rate for sign-in). Meta's send API does not
   * take a category and the sender never checks it, so a template of another category is still
   * sent as configured; only the cost estimate then differs from Meta's invoice (OWN-93).
   */
  category: 'AUTHENTICATION' | 'UTILITY';
  required: boolean;
  /** What the message is for, and which code sends it. */
  purpose: string;
  /** Body parameters in order: `{{1}}`, `{{2}}`, ... */
  body: readonly TemplateParameter[];
  /** A URL button's single parameter, when the template has one. */
  button: TemplateParameter | null;
}

export const TEMPLATE_SLOTS: readonly TemplateSlot[] = [
  {
    slot: 'otp',
    env: 'META_OTP_TEMPLATE',
    localeEnv: 'META_OTP_TEMPLATE_LOCALE',
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
    category: 'UTILITY',
    required: true,
    purpose:
      'trial reminder 7, 2 and 1 days before the trial ends (sendTrialNotice, billing/trial-notice-sweep.ts)',
    body: ['daysLeft', 'endsOn', 'billingUrl'],
    button: null,
  },
];

/** A slot's template as the environment configures it: the exact name and language sent to Meta. */
export interface ConfiguredTemplate {
  readonly name: string;
  readonly locale: string;
}

/** Every slot's configured template; null where the slot is not configured. */
export type MetaTemplates = Readonly<Record<TemplateSlotId, ConfiguredTemplate | null>>;

/** No slot configured: what a sender built without template settings sends through (nothing). */
export const NO_TEMPLATES: MetaTemplates = {
  otp: null,
  billing: null,
  retention: null,
  document: null,
  trial: null,
};

/**
 * Meta template names are lowercase letters, digits and underscores (WhatsApp Manager refuses
 * anything else), at most 512 characters.
 */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;

/** A Meta language code: `en`, `fr`, `en_US`, `pt_BR`, `ha` and similar. */
const TEMPLATE_LOCALE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

/** How one setting reads, without its value: unset (absent or empty), set and valid, or invalid. */
export type SettingState = 'unset' | 'set' | 'invalid';

export interface TemplateSlotStatus {
  slot: TemplateSlotId;
  env: string;
  localeEnv: string;
  required: boolean;
  name: SettingState;
  locale: SettingState;
}

function stateOf(value: string | undefined, valid: RegExp): SettingState {
  if (value === undefined || value === '') return 'unset';
  return valid.test(value) ? 'set' : 'invalid';
}

/** Each slot's two settings, classified, never echoed. */
export function templateSlotStatus(env: NodeJS.ProcessEnv): TemplateSlotStatus[] {
  return TEMPLATE_SLOTS.map((s) => ({
    slot: s.slot,
    env: s.env,
    localeEnv: s.localeEnv,
    required: s.required,
    name: stateOf(env[s.env], TEMPLATE_NAME),
    locale: stateOf(env[s.localeEnv], TEMPLATE_LOCALE),
  }));
}

export interface TemplateConfigProblem {
  env: string;
  problem: string;
}

/**
 * What is wrong with the template settings, without printing any value. Each problem refuses a
 * boot (`config.ts`):
 *
 *   - a name or language that is set but malformed: every send through it would be refused by
 *     Meta, which looks like an approval problem rather than a typo;
 *   - a template set without its language: the repository assumes no language (OWN-93), and Meta
 *     matches a template by name AND language, so guessing one would send a template that may not
 *     exist in that language.
 *
 * Empty means unset, so a copied `.env.example` boots. An unset template is not a problem here:
 * the sender refuses that message type as not sent, and the staging check reports a required one.
 * A language set for an unset template is inert and only reported by the staging check.
 */
export function templateConfigProblems(env: NodeJS.ProcessEnv): TemplateConfigProblem[] {
  const problems: TemplateConfigProblem[] = [];
  for (const s of templateSlotStatus(env)) {
    if (s.name === 'invalid') {
      problems.push({
        env: s.env,
        problem: 'must be a Meta template name (lowercase letters, digits and underscores)',
      });
    }
    if (s.locale === 'invalid') {
      problems.push({
        env: s.localeEnv,
        problem: 'must be a Meta language code such as en or en_US',
      });
    } else if (s.name !== 'unset' && s.locale === 'unset') {
      problems.push({
        env: s.localeEnv,
        problem: `must be set when ${s.env} is set: the language code WhatsApp Manager shows for that template`,
      });
    }
  }
  return problems;
}

/**
 * The configured template of every slot, exactly as the environment names it. Call only on an
 * environment `templateConfigProblems` accepts (`loadConfig` does): it throws otherwise, so a
 * template can never be paired with a guessed language.
 */
export function configuredTemplates(env: NodeJS.ProcessEnv): MetaTemplates {
  const problem = templateConfigProblems(env)[0];
  if (problem) throw new Error(`${problem.env} ${problem.problem}`);
  const out: Record<TemplateSlotId, ConfiguredTemplate | null> = { ...NO_TEMPLATES };
  for (const s of TEMPLATE_SLOTS) {
    const name = env[s.env];
    const locale = env[s.localeEnv];
    out[s.slot] = name && locale ? { name, locale } : null;
  }
  return out;
}

/** The slots whose template variable is unset or empty. */
export function missingTemplateSlots(env: NodeJS.ProcessEnv): TemplateSlot[] {
  return TEMPLATE_SLOTS.filter((s) => !env[s.env]);
}

/**
 * The merchant's billing page, built from `REKODA_WEB_URL` (the dashboard's origin for this
 * environment). Null when there is no usable origin,
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
