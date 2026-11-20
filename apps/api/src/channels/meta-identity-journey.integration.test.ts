/**
 * G-135, G-136 and G-137 together (owner review of #437 at 3a60b0f, item 7).
 *
 * The three fixes meet in one message path: which customer a message may name
 * (G-137), which phones, emails and names become customers (G-135, BA-OD-3) and
 * what the history keeps (G-136). One merchant's day runs through all of them,
 * and after EVERY message the whole footprint is compared, not only the reply:
 * customers and their identities, drafts by intent and state, invoices,
 * payments, ledger lines, conversation bodies, AI units held, and whether a
 * typed phone, email or name reached any table as plaintext.
 */
import { describe, expect, it } from 'vitest';
import { identity, sql, usageRepo, withBusiness } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
} from './meta-webhook.fixtures.js';
import { drain } from './meta-voice-note.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const PHONE = '08039998888';
const EMAIL = 'tola.ade@example.com';
const UNKNOWN_NAME = 'Bisi Lawal';

async function seedMerchant() {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  return identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
}

let wamid = 0;
async function say(command: unknown, text: string) {
  stubTransport.replyWith(command);
  await plain(text);
}
async function plain(text: string) {
  wamid += 1;
  await post(messagePayload(OWNER, `wamid.J${wamid}`, text));
  await drain();
  return `wamid.J${wamid}`;
}

interface Footprint {
  customers: number;
  identities: string;
  drafts: string;
  invoices: number;
  payments: number;
  ledgerLines: number;
  /** Inbound rows holding text, not a placeholder: always 0 since G-136. (Outbound rows
   * may hold a document's caption, its number and amount; `plaintext` covers them.) */
  textStored: number;
  /** AI units the meter holds as used (a refused or failed message gives its unit back). */
  aiHeld: number;
  /** Tables holding a typed phone, email or unknown name, or a provisional token. */
  plaintext: string[];
}

async function footprint(businessId: string): Promise<Footprint> {
  return withBusiness(db, businessId, async (tx) => {
    const [row] = [
      ...(await tx.execute<Omit<Footprint, 'plaintext'>>(sql`
        SELECT
          (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid) AS customers,
          (SELECT coalesce(string_agg(facet, ',' ORDER BY facet), '') FROM customer_identities
            WHERE business_id = ${businessId}::uuid) AS identities,
          (SELECT coalesce(string_agg(intent || ':' || state, ',' ORDER BY insertion_seq), '')
             FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*)::int FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*)::int FROM ledger_entries WHERE business_id = ${businessId}::uuid) AS "ledgerLines",
          (SELECT count(*)::int FROM conversation_messages
            WHERE business_id = ${businessId}::uuid AND direction = 'inbound'
              AND body !~ '^\\[[a-z0-9_: ]+\\]$') AS "textStored",
          (SELECT coalesce(sum(used), 0)::int FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS "aiHeld"`)),
    ];
    const plaintext: string[] = [];
    for (const table of [
      'expenses',
      'invoices',
      'invoice_items',
      'payments',
      'ledger_transactions',
      'ledger_entries',
      'command_drafts',
      'conversation_messages',
      'audit_events',
    ]) {
      for (const needle of ['8039998888', EMAIL, UNKNOWN_NAME, 'CUSTOMER_U']) {
        const [hit] = [
          ...(await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} t
                 WHERE t.business_id = ${businessId}::uuid AND t::text LIKE ${'%' + needle + '%'}`,
          )),
        ];
        if ((hit?.n ?? 0) > 0) plaintext.push(`${table}:${needle}`);
      }
    }
    return { ...row!, plaintext };
  });
}

const sale = (customer: unknown, quantity = 2) => ({
  intent: 'RecordSale',
  customer,
  items: [{ name: 'wig', quantity, unitPrice: 50_000 }],
  statedTotal: quantity * 50_000,
  reportedPayment: 0,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
});
const payment = (customer: unknown, amount: number) => ({
  intent: 'RecordPayment',
  customer,
  amount,
  relativeAmount: null,
  documentRef: null,
  paymentMethod: 'cash',
});
const balanceOf = (customer: unknown) => ({
  intent: 'Query',
  topic: 'customer_balance',
  customer,
  period: 'month',
  periodText: null,
  format: 'chat',
});

describe('one merchant, every identity case, footprint checked after each message', () => {
  it('creates, refuses, confirms and stores exactly what each message means', async () => {
    const business = await seedMerchant();
    const ada = await deps.gateway.resolveMention(business.id, 'Ada Obi');
    let was = await footprint(business.id);
    const changedBy = async (expected: Partial<Footprint>) => {
      const now = await footprint(business.id);
      expect(now).toEqual({ ...was, ...expected });
      was = now;
    };

    /* 1. A known customer by name: a sale preview, then yes. */
    await say(sale({ kind: 'token', token: ada.token }), 'sold Ada Obi 2 wigs for 100k');
    expect(stubTransport.requests.at(-1)?.userText).not.toContain('Ada Obi');
    await changedBy({ drafts: 'RecordSale:pending', aiHeld: 1 });
    await plain('yes');
    const afterSale = await footprint(business.id);
    expect(afterSale).toMatchObject({ drafts: 'RecordSale:confirmed', invoices: 1, customers: 1 });
    expect(afterSale.ledgerLines).toBeGreaterThan(0);
    was = afterSale;

    /* 2. A partial payment by the same customer, then her balance. */
    await say(payment({ kind: 'token', token: ada.token }, 40_000), 'Ada Obi paid 40k cash');
    await plain('yes');
    const afterPayment = await footprint(business.id);
    expect(afterPayment).toMatchObject({ payments: 1, customers: 1 });
    was = afterPayment;
    await say(balanceOf({ kind: 'token', token: ada.token }), 'how much does Ada Obi owe me');
    expect(stubSender.lastText).toContain('₦60,000');
    await changedBy({
      drafts: `${was.drafts},Query:pending`,
      aiHeld: was.aiHeld + 1,
    });

    /* 3. An unknown name asked about, twice: nobody is created either time. The
     * name reaches the model each time (the PROPOSED ADR 0005 Amendment 1 case 2,
     * awaiting the owner's ruling), and is stored nowhere. */
    for (let ask = 0; ask < 2; ask += 1) {
      await say(
        balanceOf({ kind: 'mention', mention: UNKNOWN_NAME }),
        `how much does ${UNKNOWN_NAME} owe me`,
      );
      expect(stubTransport.requests.at(-1)?.userText).toContain(UNKNOWN_NAME);
      expect(stubSender.lastText).toContain('do not have a customer by that name');
      await changedBy({
        drafts: `${was.drafts},Query:pending`,
        aiHeld: was.aiHeld + 1,
      });
    }

    /* 4. An unknown phone asked about: no customer, never sent to the model. */
    await say(balanceOf({ kind: 'token', token: 'CUSTOMER_U01' }), `how much does ${PHONE} owe me`);
    expect(stubTransport.requests.at(-1)?.userText).not.toContain(PHONE);
    await changedBy({
      drafts: `${was.drafts},Query:pending`,
      aiHeld: was.aiHeld + 1,
    });

    /* 5. The same phone only in an expense's words: no customer, "[phone]" kept. */
    await say(
      {
        intent: 'RecordExpense',
        description: 'repairs, call CUSTOMER_U01',
        amount: 5_000,
        category: 'repairs',
        paymentMethod: 'cash',
      },
      `paid 5k cash for repairs, call ${PHONE}`,
    );
    expect(stubSender.lastText).toContain('[phone]');
    await plain('yes');
    const afterExpense = await footprint(business.id);
    expect(afterExpense).toMatchObject({ customers: 1, identities: 'name', plaintext: [] });
    was = afterExpense;

    /* 6. A payment carrying a token nobody issued: refused, nothing drafted that a
     * yes could post, the unit given back; the yes after it confirms nothing. */
    const invented = ada.token === 'CUSTOMER_Q9Q' ? 'CUSTOMER_Q9R' : 'CUSTOMER_Q9Q';
    await say(payment({ kind: 'token', token: invented }, 20_000), 'Tola paid 20k');
    expect(stubSender.lastText).toContain('could not tell which customer');
    await changedBy({ drafts: `${was.drafts},Unclear:pending` });
    await plain('yes');
    expect(stubSender.lastText).toContain('nothing waiting for a yes');
    await changedBy({ drafts: was.drafts.replace(/Unclear:pending$/, 'Unclear:superseded') });

    /* 7. A sale to an unknown email, corrected before the yes: one customer, the
     * corrected sale, the email in the vault only. */
    await say(
      sale({ kind: 'token', token: 'CUSTOMER_U01' }, 2),
      `sold 2 wigs to ${EMAIL} for 100k`,
    );
    /* The email is a customer from the first preview on, so the correction carries
     * that customer's stored token, as the model is shown it. */
    const tola = (await deps.gateway.tokenise(business.id, `to ${EMAIL}`)).text.match(
      /CUSTOMER_[0-9A-Z]{3,}/,
    )![0];
    await say(sale({ kind: 'token', token: tola }, 3), `sorry, 3 not 2, to ${EMAIL}`);
    await plain('yes');
    const afterCorrection = await footprint(business.id);
    expect(afterCorrection).toMatchObject({
      customers: 2,
      identities: 'email,name',
      invoices: 2,
      plaintext: [],
      textStored: 0,
    });
    /* The second invoice is the corrected three-wig sale (CodeRabbit on #437). */
    const totals = await withBusiness(db, business.id, async (tx) =>
      [
        ...(await tx.execute<{ total: string }>(
          sql`SELECT total_k::text AS total FROM invoices
               WHERE business_id = ${business.id}::uuid ORDER BY created_at`,
        )),
      ].map((r) => r.total),
    );
    expect(totals).toEqual(['10000000', '15000000']);
    was = afterCorrection;

    /* 8. The provider fails, then the model answers nonsense: nothing changes but a
     * refusal draft each time (holding only its sentence), and no unit is kept. */
    stubTransport.script(new Error('provider timeout'));
    await plain('Tola paid 20k');
    await changedBy({ drafts: `${was.drafts},Unclear:pending` });
    stubTransport.replyWith({ intent: 'Nonsense' });
    await plain('Tola paid 20k');
    await changedBy({ drafts: `${was.drafts},Unclear:pending` });

    /* 9. Meta redelivers an earlier message: deduplicated, nothing changes. */
    await post(messagePayload(OWNER, 'wamid.J1', 'sold Ada Obi 2 wigs for 100k'));
    await drain();
    await changedBy({});

    /* 10. A preview, then the AI allowance runs out: the next message is refused
     * before any model call, and the yes after the refusal confirms nothing. */
    await say(sale({ kind: 'token', token: ada.token }, 1), 'sold Ada Obi 1 wig for 50k');
    expect(stubSender.lastText).toContain('Reply *yes*');
    was = await footprint(business.id);
    /* Spend the rest of the trial's allowance, a unit at a time, until the database
     * (which holds the allowance, 0222) refuses one. */
    let spent = 0;
    while (
      spent < 10_000 &&
      (await withBusiness(db, business.id, (tx) =>
        usageRepo.consumeUnit(tx, business.id, usagePeriod(new Date()), 'AI_ACTIONS', 1_000_000, 1),
      ))
    ) {
      spent += 1;
    }
    expect(spent).toBeLessThan(10_000);
    const exhausted = await footprint(business.id);
    const calls = stubTransport.requests.length;
    await plain('Tola paid 20k');
    expect(stubTransport.requests.length).toBe(calls);
    expect(stubSender.lastText).not.toContain('Reply *yes*');
    expect(await footprint(business.id)).toEqual({
      ...exhausted,
      drafts: `${exhausted.drafts},Unclear:pending`,
    });
    /* The yes was about the refusal: nothing saved, the preview pointed at. */
    await plain('yes');
    expect(stubSender.lastText).toContain('still a preview waiting');
    expect((await footprint(business.id)).invoices).toBe(was.invoices);

    was = await footprint(business.id);
    expect(was.textStored).toBe(0);
    expect(was.plaintext).toEqual([]);
  });
});
