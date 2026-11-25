/**
 * OD-73 Option A (owner ruling OWN-106, 25 Nov 2026): the record-intent exception to canonical spec
 * Appendix C.3, as ADR 0005 Amendment 1 case 4 states it.
 *
 * PERMITTED: a customer name nobody has recorded, typed in a record request (here a sale), reaches
 * the approved interpreter as typed, and only until Rekoda can tokenise it: the command vaults the
 * name, so the next message that names them reaches the model as a token.
 *
 * FORBIDDEN, each asserted: a recorded name, a phone or an email reaching the model untokenised; more
 * than the primary call and one escalation for one message; the name in any stored row the record
 * path writes (conversation history, drafts, books), in a log line or in a usage event. That the
 * interpreter is Anthropic on Anthropic's host outside development and test is enforced at boot and
 * pinned in `src/config/ai-provider.test.ts` (OWN-103(6)).
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql, withBusiness } from '@rekoda/db';
import { db, deps, stubTransport, useMetaWebhookHarness } from './meta-webhook.fixtures.js';
import { plaintextIn, sale, say, seedMerchant } from './meta-customer-token.fixtures.js';

useMetaWebhookHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every Nest log line written while `run` runs, as text. */
async function logsDuring(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  await run();
  return lines.join('\n');
}

const usageMeta = async (businessId: string): Promise<string[]> => {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ meta: string }>(sql`
      SELECT coalesce(meta::text, '') AS meta FROM usage_events
       WHERE business_id = ${businessId}::uuid`),
  );
  return [...rows].map((r) => r.meta);
};

describe('a first-mentioned customer name in a record (OD-73, OWN-106)', () => {
  it('reaches the interpreter as typed once, then only as a token, and is never stored, logged or metered', async () => {
    const business = await seedMerchant();
    stubTransport.requests.length = 0;

    const logs = await logsDuring(() =>
      say(
        'wamid.OD73-1',
        sale({ kind: 'mention', mention: 'Ada Obi' }),
        'sold Ada Obi 2 wigs for 100k',
      ),
    );

    /* Permitted: the unrecorded name, as typed, to the interpreter. At most primary + one escalation. */
    expect(stubTransport.requests.length).toBeGreaterThan(0);
    expect(stubTransport.requests.length).toBeLessThanOrEqual(2);
    expect(stubTransport.requests.every((r) => r.userText.includes('Ada Obi'))).toBe(true);
    /* Forbidden: anywhere it would outlive the call. */
    expect(logs).not.toContain('Ada Obi');
    expect((await usageMeta(business.id)).join('\n')).not.toContain('Ada Obi');
    expect(await plaintextIn(business.id, ['Ada Obi'])).toEqual([]);

    /* Vaulted by that command: the next message that names her reaches the model as a token. */
    const ada = await deps.gateway.findMention(business.id, 'Ada Obi');
    expect(ada).not.toBeNull();
    stubTransport.requests.length = 0;
    await say(
      'wamid.OD73-2',
      sale({ kind: 'token', token: ada!.token }),
      'sold Ada Obi 1 wig for 50k',
    );
    expect(stubTransport.requests.length).toBeGreaterThan(0);
    for (const request of stubTransport.requests) {
      expect(request.userText).not.toContain('Ada Obi');
      expect(request.userText).toContain(ada!.token);
    }
  });

  it('never extends to a phone or an email typed beside the new name: those are tokenised first', async () => {
    const business = await seedMerchant();
    stubTransport.requests.length = 0;

    await say(
      'wamid.OD73-3',
      sale({ kind: 'mention', mention: 'Bola Ige' }),
      'sold Bola Ige 08035550199 bola@example.test 2 wigs for 100k',
    );

    expect(stubTransport.requests.length).toBeGreaterThan(0);
    for (const request of stubTransport.requests) {
      expect(request.userText).toContain('Bola Ige');
      expect(request.userText).not.toContain('08035550199');
      expect(request.userText).not.toContain('bola@example.test');
    }
    expect(
      await plaintextIn(business.id, ['Bola Ige', '08035550199', 'bola@example.test']),
    ).toEqual([]);
  });
});
