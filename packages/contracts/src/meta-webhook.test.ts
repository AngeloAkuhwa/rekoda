import { describe, expect, it } from 'vitest';
import { extractInboundEvents, metaWebhookBody } from './meta-webhook.js';

const textMessage = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
            contacts: [{ profile: { name: 'Ada' }, wa_id: '2348031234567' }],
            messages: [
              {
                id: 'wamid.ABC',
                from: '2348031234567',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'Ada bought 3 wigs for 150k' },
              },
            ],
          },
        },
      ],
    },
  ],
};

describe('parsing what Meta sends', () => {
  it('flattens a text message out of four levels of nesting', () => {
    const parsed = metaWebhookBody.parse(textMessage);
    const [event] = extractInboundEvents(parsed);
    expect(event).toMatchObject({
      kind: 'message',
      externalId: 'wamid.ABC',
      from: '2348031234567',
      phoneNumberId: 'PNID',
      messageType: 'text',
      text: 'Ada bought 3 wigs for 150k',
    });
  });

  it('keeps sent, delivered and read as three separate events', () => {
    // Keyed on the message id alone, the second and third would be discarded
    // as duplicates and delivery tracking would silently stop at "sent".
    const body = metaWebhookBody.parse({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.X', status: 'sent' },
                  { id: 'wamid.X', status: 'delivered' },
                  { id: 'wamid.X', status: 'read' },
                ],
              },
            },
          ],
        },
      ],
    });
    const ids = extractInboundEvents(body).map((e) => e.externalId);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('wamid.X:delivered');
  });

  it('accepts a payload with nothing in it', () => {
    // Meta sends these. Throwing would earn a retry for an empty envelope.
    expect(extractInboundEvents(metaWebhookBody.parse({ entry: [] }))).toEqual([]);
    expect(extractInboundEvents(metaWebhookBody.parse({}))).toEqual([]);
  });

  it('tolerates fields it has never seen', () => {
    // Meta ships product updates without asking. A parser that rejects an
    // unfamiliar shape turns one of those into an outage.
    const withExtras = {
      ...textMessage,
      unexpected_top_level: true,
      entry: [
        {
          ...textMessage.entry[0],
          changes: [
            {
              field: 'messages',
              value: {
                ...textMessage.entry[0]!.changes[0]!.value,
                some_new_field: { nested: 'value' },
              },
            },
          ],
        },
      ],
    };
    expect(() => metaWebhookBody.parse(withExtras)).not.toThrow();
    expect(extractInboundEvents(metaWebhookBody.parse(withExtras))).toHaveLength(1);
  });

  it('skips a message with no id rather than inventing one', () => {
    const result = metaWebhookBody.safeParse({
      entry: [{ changes: [{ value: { messages: [{ from: '234', type: 'text' }] } }] }],
    });
    expect(result.success).toBe(false);
  });

  it('reads a non-text message without pretending it has text', () => {
    const body = metaWebhookBody.parse({
      entry: [
        {
          changes: [{ value: { messages: [{ id: 'wamid.AUD', from: '234803', type: 'audio' }] } }],
        },
      ],
    });
    const [event] = extractInboundEvents(body);
    expect(event?.messageType).toBe('audio');
    expect(event?.text).toBeNull();
  });
});
