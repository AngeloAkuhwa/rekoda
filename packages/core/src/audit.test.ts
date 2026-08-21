import { describe, expect, it } from 'vitest';
import { describeActor, describeAuditEvent } from './audit.js';

const describe_ = (entity: string, action: string, newValue: unknown, oldValue: unknown = null) =>
  describeAuditEvent({ entity, action, oldValue, newValue });

describe('every shape a writer actually stores', () => {
  it('names the invoice on an issue, and carries the total as a figure', () => {
    expect(
      describe_('invoice', 'issued', {
        invoiceNumber: 'INV-2026-000041',
        docHash: 'abc',
        totalK: 15_000_000,
      }),
    ).toEqual({ summary: 'Invoice INV-2026-000041 issued', amountK: 15_000_000 });
  });

  it('says withdrawn rather than voided, because that is the word on the register', () => {
    expect(describe_('invoice', 'voided', { documentNumber: 'INV-2026-000041' })).toEqual({
      summary: 'Invoice INV-2026-000041 withdrawn',
      amountK: null,
    });
  });

  it('names both documents on a credit note, and carries the amount', () => {
    expect(
      describe_('invoice', 'credited', {
        creditNoteNumber: 'CRN-2026-000003',
        invoiceNumber: 'INV-2026-000041',
        amountK: 9_000_000,
      }),
    ).toEqual({
      summary: 'Credit note CRN-2026-000003 issued against invoice INV-2026-000041',
      amountK: 9_000_000,
    });
  });

  it('tells a withdrawn expense from a withdrawn stock purchase', () => {
    expect(describe_('expense', 'voided', { description: 'diesel', kind: 'expense' }).summary).toBe(
      'Expense "diesel" withdrawn',
    );
    expect(
      describe_('expense', 'voided', { description: 'ankara bales', kind: 'purchase' }).summary,
    ).toBe('Stock purchase "ankara bales" withdrawn');
  });

  /**
   * The allocation, never the gross. They differ by whatever fee was taken,
   * and the books only ever moved by the allocation - a trail that showed the
   * gross would not reconcile against the ledger it exists to explain.
   */
  it('reports what SETTLED the invoice on a confirmed payment, not what was sent', () => {
    expect(
      describe_('payment', 'confirmed', {
        rekodaReference: 'RKD-XYZ',
        amountK: 6_000_000,
        allocatedK: 5_900_000,
        providerType: 'paystack',
        at: '2026-08-21T10:00:00.000Z',
      }),
    ).toEqual({ summary: 'Payment RKD-XYZ confirmed by the provider', amountK: 5_900_000 });
  });

  it('falls back to the gross when no allocation was stored', () => {
    expect(
      describe_('payment', 'confirmed', { rekodaReference: 'RKD-XYZ', amountK: 6_000_000 }).amountK,
    ).toBe(6_000_000);
  });

  it('names the invoice a merchant-recorded payment went against', () => {
    expect(
      describe_('payment', 'recorded', {
        invoiceNumber: 'INV-2026-000041',
        amountK: 2_000_000,
        receiptNumber: 'RCT-2026-000012',
        verified: false,
      }),
    ).toEqual({ summary: 'Payment recorded against invoice INV-2026-000041', amountK: 2_000_000 });
  });

  it('reads a plan change in both directions', () => {
    expect(
      describe_('business', 'plan_changed', { plan: 'growth' }, { plan: 'starter' }).summary,
    ).toBe('Plan changed from starter to growth');
  });

  it('covers the rest of the subscription lifecycle', () => {
    expect(describe_('business', 'upgrade_requested', { fromPlan: 'starter' }).summary).toBe(
      'Upgrade requested from starter',
    );
    expect(
      describe_('business', 'subscription_expired', { plan: 'expired' }, { plan: 'growth' })
        .summary,
    ).toBe('Subscription ended on the growth plan');
    expect(
      describe_('subscription_charge', 'refunded', {
        amountK: 500_000,
        reason: 'duplicate_charge',
        status: 'refunded',
      }),
    ).toEqual({ summary: 'Charge refunded (duplicate charge)', amountK: 500_000 });
  });

  /**
   * Both directions, because they are different events. A count that finds
   * less than the books claim is a loss; one that finds more is not, and a
   * row that read the same for both would leave a reader to work it out from
   * a sign they cannot see.
   */
  it('says which way a stock count went, and carries what moved', () => {
    expect(describe_('stock_count', 'adjusted', { differenceK: -3_800_000 })).toEqual({
      summary: 'Stock written down to a count',
      amountK: 3_800_000,
    });
    expect(describe_('stock_count', 'adjusted', { differenceK: 1_200_000 })).toEqual({
      summary: 'Stock written up to a count',
      amountK: 1_200_000,
    });
  });

  it('counts erased records, and gets the singular right', () => {
    expect(describe_('customer_identities', 'erased', { facetsDeleted: 1 }).summary).toBe(
      'Customer details erased on request (1 record)',
    );
    expect(describe_('customer_identities', 'erased', { facetsDeleted: 3 }).summary).toBe(
      'Customer details erased on request (3 records)',
    );
  });
});

/**
 * The direction the unknown case must fail in.
 *
 * A writer added after this file was last read has to be DULL here, never
 * loud: naming the entity and the action is useful, and printing whatever it
 * chose to store would put a merchant's page at the mercy of a decision made
 * somewhere else.
 */
describe('a shape this file has never seen', () => {
  it('names what happened and prints nothing that was stored', () => {
    const result = describe_('mystery_entity', 'did_something', {
      secret: 'CUSTOMER_7K2',
      phone: '+2348120000001',
    });
    expect(result).toEqual({ summary: 'mystery entity: did something', amountK: null });
    expect(result.summary).not.toContain('CUSTOMER_');
    expect(result.summary).not.toContain('234');
  });

  it('survives a null, a string and an array where an object was expected', () => {
    for (const value of [null, undefined, 'a string', [1, 2, 3], 42]) {
      expect(() => describe_('invoice', 'issued', value)).not.toThrow();
    }
    expect(describe_('invoice', 'issued', null)).toEqual({
      summary: 'An invoice was issued',
      amountK: null,
    });
  });

  it('ignores a total that is not an integer number of kobo', () => {
    expect(
      describe_('invoice', 'issued', { invoiceNumber: 'INV-1', totalK: '15000000' }).amountK,
    ).toBeNull();
    expect(
      describe_('invoice', 'issued', { invoiceNumber: 'INV-1', totalK: 1.5 }).amountK,
    ).toBeNull();
  });
});

describe('who did it', () => {
  it('resolves a member to their name, and keeps the id when it cannot', () => {
    const names = (id: string) => (id === 'u-1' ? 'Ada' : undefined);
    expect(describeActor('user:u-1', names)).toBe('Ada');
    /* An id support can look up beats "somebody", which answers nothing. */
    expect(describeActor('user:u-2', names)).toBe('user:u-2');
    expect(describeActor('user:u-1')).toBe('user:u-1');
  });

  it('says plainly which actors are not people', () => {
    expect(describeActor('operator:angelo')).toBe('Rekoda support');
    expect(describeActor('merchant')).toBe('You, in chat');
    expect(describeActor('system')).toBe('Rekoda, automatically');
    expect(describeActor('system:payments')).toBe('Rekoda, automatically');
    expect(describeActor('webhook:paystack')).toBe('paystack (payment provider)');
  });

  /* An operator's name is Rekoda's business, not the merchant's: it would put
   * a colleague's identity on a customer-facing page to no purpose. */
  it('never puts a support engineer`s name on the merchant`s page', () => {
    expect(describeActor('operator:angelo')).not.toContain('angelo');
  });
});
