/**
 * The audit trail, said in English (MASTER-PLAN §42).
 *
 * `audit_events` has been written since M1 by five repos and read by nothing,
 * which meant the compliance record Rekoda keeps has never been shown to the
 * merchant it is kept for. This is the layer that turns a row into a sentence
 * a person can check.
 *
 * Pure, and deliberately here rather than in the controller or the page: what
 * a stored change MEANS is a decision about the product, and it belongs
 * somewhere a test can pin every case at once. No model is anywhere near it.
 *
 * ── on what is safe to say ─────────────────────────────────────────────────
 *
 * Every writer's `new_value` was inventoried before this was built: invoice
 * numbers, integer kobo, plan names, provider references, counts, ISO dates.
 * No customer name and no CUSTOMER_ token is stored in one, and none may
 * become storable without revisiting this file, because whatever a writer
 * puts there is what a merchant will read here.
 *
 * An unrecognised shape falls back to naming the entity and the action rather
 * than printing the payload. A future writer that stored something private
 * would then be dull on this page instead of loud, which is the correct
 * direction for the mistake to fail in.
 */

export interface AuditRow {
  readonly entity: string;
  readonly action: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
}

export interface AuditDescription {
  /** One sentence, no money in it — see `amountK`. */
  readonly summary: string;
  /**
   * The figure this change was about, when it was about one. Kept out of the
   * sentence so the page renders it through the one money component, which is
   * what keeps a screen and a document from ever disagreeing.
   */
  readonly amountK: number | null;
}

const str = (v: unknown, key: string): string | null => {
  if (typeof v !== 'object' || v === null) return null;
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const int = (v: unknown, key: string): number | null => {
  if (typeof v !== 'object' || v === null) return null;
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

/** `plan_changed` reads better than "plan changed" nowhere, so: spaces. */
const humanise = (token: string): string => token.replace(/_/g, ' ');

export function describeAuditEvent(row: AuditRow): AuditDescription {
  const { entity, action, oldValue, newValue } = row;

  if (entity === 'invoice' && action === 'issued') {
    const number = str(newValue, 'invoiceNumber');
    return {
      summary: number ? `Invoice ${number} issued` : 'An invoice was issued',
      amountK: int(newValue, 'totalK'),
    };
  }

  if (entity === 'invoice' && action === 'voided') {
    const number = str(newValue, 'documentNumber');
    return {
      summary: number ? `Invoice ${number} withdrawn` : 'An invoice was withdrawn',
      amountK: null,
    };
  }

  if (entity === 'expense' && action === 'voided') {
    const what = str(newValue, 'description');
    const kind = str(newValue, 'kind') === 'purchase' ? 'Stock purchase' : 'Expense';
    return {
      summary: what ? `${kind} "${what}" withdrawn` : `${kind} withdrawn`,
      amountK: null,
    };
  }

  if (entity === 'payment' && action === 'confirmed') {
    const reference = str(newValue, 'rekodaReference');
    return {
      summary: reference
        ? `Payment ${reference} confirmed by the provider`
        : 'A payment was confirmed by the provider',
      /* What settled the invoice, not what the customer sent. The gross and
       * the allocation differ whenever a fee was taken, and the books only
       * ever moved by the allocation. */
      amountK: int(newValue, 'allocatedK') ?? int(newValue, 'amountK'),
    };
  }

  if (entity === 'payment' && action === 'recorded') {
    const invoice = str(newValue, 'invoiceNumber');
    return {
      summary: invoice ? `Payment recorded against invoice ${invoice}` : 'A payment was recorded',
      amountK: int(newValue, 'amountK'),
    };
  }

  if (entity === 'business' && action === 'plan_changed') {
    const from = str(oldValue, 'plan');
    const to = str(newValue, 'plan');
    return {
      summary: from && to ? `Plan changed from ${from} to ${to}` : 'The plan was changed',
      amountK: null,
    };
  }

  if (entity === 'business' && action === 'upgrade_requested') {
    const from = str(newValue, 'fromPlan');
    return {
      summary: from ? `Upgrade requested from ${from}` : 'An upgrade was requested',
      amountK: null,
    };
  }

  if (entity === 'business' && action === 'subscription_expired') {
    const from = str(oldValue, 'plan');
    return {
      summary: from ? `Subscription ended on the ${from} plan` : 'The subscription ended',
      amountK: null,
    };
  }

  if (entity === 'subscription_charge' && action === 'refunded') {
    const why = str(newValue, 'reason');
    return {
      summary: why ? `Charge refunded (${humanise(why)})` : 'A charge was refunded',
      amountK: int(newValue, 'amountK'),
    };
  }

  if (entity === 'customer_identities' && action === 'erased') {
    const count = int(newValue, 'facetsDeleted');
    return {
      summary:
        count === null
          ? 'Customer details erased on request'
          : `Customer details erased on request (${count} ${count === 1 ? 'record' : 'records'})`,
      amountK: null,
    };
  }

  /* Unknown shape. Name what happened and print nothing that was stored: a
   * writer added since this file was last read must be dull here, never loud. */
  return { summary: `${humanise(entity)}: ${humanise(action)}`, amountK: null };
}

/**
 * Who did it, for a merchant reading their own trail.
 *
 * `user:<id>` becomes whatever the caller can resolve it to - Rekoda stores
 * no names, so in practice that is the member's role and the last four digits
 * of the phone they sign in with, which is exactly what /app/team already
 * shows them. Precision matters here more than tidiness: "who did this" is
 * the entire point of an audit log, and two accountants both rendered
 * "Accountant" would defeat it.
 *
 * It stays the raw actor when nothing resolves, because an id support can
 * look up beats "somebody", which answers nothing. Everything else is a role
 * rather than a person and says so plainly: a merchant should never have to
 * wonder whether "system" is a colleague.
 */
export function describeActor(
  actor: string,
  nameFor?: (userId: string) => string | undefined,
): string {
  if (actor.startsWith('user:')) {
    const name = nameFor?.(actor.slice('user:'.length));
    return name ?? actor;
  }
  if (actor.startsWith('operator:')) return 'Rekoda support';
  if (actor === 'merchant') return 'You, in chat';
  if (actor === 'system' || actor.startsWith('system:')) return 'Rekoda, automatically';
  if (actor.startsWith('webhook:')) return `${actor.slice('webhook:'.length)} (payment provider)`;
  return actor;
}
