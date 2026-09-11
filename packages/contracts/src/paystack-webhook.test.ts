/**
 * Which pipeline a Paystack event enters, and which charge it is ABOUT
 * (G-06). The kind comes from the event name only; the reference comes from
 * wherever that kind of envelope carries the charge: `reference` on a charge
 * event, `transaction_reference` on a refund, `transaction.reference` on a
 * dispute. Getting this wrong is how every refund used to be filed as
 * "no payment reference" and quietly absorbed.
 */
import { describe, expect, it } from 'vitest';
import {
  paystackEventKind,
  paystackWebhookBody,
  summarisePaystackEvent,
} from './paystack-webhook.js';

const parse = (body: unknown) => {
  const parsed = paystackWebhookBody.safeParse(body);
  if (!parsed.success) throw new Error('fixture does not parse');
  return summarisePaystackEvent(parsed.data);
};

describe('the event kind comes from the name, never the payload', () => {
  it('classifies charge, refund, dispute and other', () => {
    expect(paystackEventKind('charge.success')).toBe('charge');
    expect(paystackEventKind('refund.processed')).toBe('refund');
    expect(paystackEventKind('refund.failed')).toBe('refund');
    expect(paystackEventKind('charge.dispute.create')).toBe('dispute');
    expect(paystackEventKind('charge.dispute.resolve')).toBe('dispute');
    expect(paystackEventKind('transfer.success')).toBe('other');
  });

  it('a charge event carrying refund-shaped fields is still a charge', () => {
    const s = parse({
      event: 'charge.success',
      data: { id: 1, reference: 'RKD-PAY-1', transaction_reference: 'RKD-PAY-OTHER', amount: 100 },
    });
    expect(s.kind).toBe('charge');
    expect(s.reference).toBe('RKD-PAY-1');
  });
});

describe('the reference is the charge the event is about', () => {
  it('a refund names its charge in transaction_reference, and its own id is the refund id', () => {
    const s = parse({
      event: 'refund.processed',
      data: {
        id: 501,
        transaction_reference: 'RKD-PAY-1',
        refund_reference: 'RF-501',
        amount: 4_000_000,
        currency: 'NGN',
        status: 'processed',
      },
    });
    expect(s).toEqual({
      fingerprint: '501:refund.processed',
      eventType: 'refund.processed',
      kind: 'refund',
      reference: 'RKD-PAY-1',
      objectId: '501',
      amountK: 4_000_000,
      currency: 'NGN',
      providerStatus: 'processed',
      resolution: null,
    });
  });

  it('a refund with the charge nested under transaction, or only in reference, still resolves', () => {
    expect(
      parse({ event: 'refund.processed', data: { id: 1, transaction: { reference: 'RKD-PAY-2' } } })
        .reference,
    ).toBe('RKD-PAY-2');
    expect(
      parse({ event: 'refund.processed', data: { id: 1, reference: 'RKD-PAY-3' } }).reference,
    ).toBe('RKD-PAY-3');
  });

  it('a dispute names its charge under transaction and its amount as refund_amount', () => {
    const s = parse({
      event: 'charge.dispute.resolve',
      data: {
        id: 602,
        refund_amount: 15_000_000,
        amount: 1,
        currency: 'NGN',
        status: 'resolved',
        resolution: 'merchant-accepted',
        transaction: { id: 9, reference: 'RKD-PAY-4', amount: 15_000_000 },
      },
    });
    expect(s.kind).toBe('dispute');
    expect(s.reference).toBe('RKD-PAY-4');
    expect(s.objectId).toBe('602');
    expect(s.amountK).toBe(15_000_000);
    expect(s.resolution).toBe('merchant-accepted');
    expect(s.fingerprint).toBe('602:charge.dispute.resolve');
  });

  it('an envelope with no id has no fingerprint and no object id', () => {
    const s = parse({ event: 'refund.processed', data: { transaction_reference: 'RKD-PAY-5' } });
    expect(s.fingerprint).toBeNull();
    expect(s.objectId).toBeNull();
    expect(s.reference).toBe('RKD-PAY-5');
  });
});

describe('the documented refund envelope (paystack.com/docs/payments/refunds, "Listen to notifications")', () => {
  /* Verbatim from the published sample, with the event and status of the
   * processed stage. Two things a fixture built by hand would not have:
   * the amount is a digit STRING, and there is no `data.id`. */
  const documented = {
    event: 'refund.processed',
    data: {
      status: 'processed',
      transaction_reference: 'tvunjbbd_412829_4b18075d_c7had',
      refund_reference: null,
      amount: '10000',
      currency: 'NGN',
      processor: 'instant-transfer',
      customer: { first_name: 'Drew', last_name: 'Berry', email: 'demo@email.com' },
      integration: 412829,
      domain: 'live',
    },
  };

  it('parses: a digit-string amount is an integer, and no id means no fingerprint and no object id', () => {
    const parsed = paystackWebhookBody.safeParse(documented);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = summarisePaystackEvent(parsed.data);
    expect(summary).toMatchObject({
      kind: 'refund',
      eventType: 'refund.processed',
      reference: 'tvunjbbd_412829_4b18075d_c7had',
      amountK: 10_000,
      objectId: null,
      fingerprint: null,
      providerStatus: 'processed',
    });
  });

  it('an amount that is not an integer kobo is no amount at all, never a posting figure', () => {
    for (const amount of ['10000.50', '-5', 'ten', 1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
      const parsed = paystackWebhookBody.safeParse({
        ...documented,
        data: { ...documented.data, amount },
      });
      if (parsed.success) {
        expect(summarisePaystackEvent(parsed.data).amountK).toBeNull();
      }
      // A shape the schema refuses is equally acceptable: it never reaches a posting.
    }
  });
});

describe('the published dispute object as a webhook body (paystack.com/docs/api/dispute)', () => {
  /* Paystack's dispute objects carry null, not absence, for the fields a
   * dispute has not filled: `transaction_reference`, `refund_amount`,
   * `currency`, `resolution`. The charge is named inside `transaction`. */
  const disputeBody = (event: string, status: string, resolution: string | null) => ({
    event,
    data: {
      id: 2867,
      refund_amount: null,
      currency: null,
      status,
      resolution,
      domain: 'live',
      transaction: {
        id: 5991760,
        domain: 'live',
        status: 'success',
        reference: 'asjck8gf76zd1dr',
        amount: 39100,
        currency: 'NGN',
      },
      transaction_reference: null,
      category: 'general',
      customer: { id: 16200, email: 'demo@email.com' },
      bin: '424242',
      last4: '4242',
      dueAt: '2019-08-30T16:10:41.000Z',
      resolvedAt: null,
      evidence: null,
      attachments: '[]',
      note: null,
      history: [],
      messages: [],
    },
  });

  it.each([
    ['charge.dispute.create', 'awaiting-merchant-feedback', null],
    ['charge.dispute.remind', 'awaiting-merchant-feedback', null],
    ['charge.dispute.resolve', 'resolved', 'merchant-accepted'],
  ])(
    '%s with null fields parses and names the charge from transaction.reference',
    (event, status, resolution) => {
      const parsed = paystackWebhookBody.safeParse(disputeBody(event, status, resolution));
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(summarisePaystackEvent(parsed.data)).toMatchObject({
        kind: 'dispute',
        eventType: event,
        reference: 'asjck8gf76zd1dr',
        objectId: '2867',
        fingerprint: `2867:${event}`,
        amountK: null,
        currency: null,
        providerStatus: status,
        resolution,
      });
    },
  );
});
