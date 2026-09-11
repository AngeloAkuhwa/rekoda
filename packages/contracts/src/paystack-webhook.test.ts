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
