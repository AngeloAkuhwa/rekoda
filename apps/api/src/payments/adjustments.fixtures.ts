/**
 * Shared setup for the provider adjustment suites (refunds, reversals, chargebacks; G-06),
 * split from adjustments.integration.test.ts: one worker over a real PostgreSQL, the stub
 * provider and sender, and the event and ledger helpers. Each suite calls
 * useAdjustmentsHarness() once at its top level; Vitest gives every test file its own copy of
 * this module.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import {
  accountsRepo,
  chargebacksRepo,
  createDb,
  events,
  identity,
  issueRepo,
  paymentsHub,
  refundsRepo,
  settleRepo,
  settlementsRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { StubPaymentProvider } from './provider.stub.js';
import { pumpPaystackEvents } from './paystack-pump.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-adj-'));

let urls: Urls;
export let appDb: Db;
export let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
export let provider: StubPaymentProvider;
let stubSender: StubSender;
export let deps: RunnerDeps;

function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

/* ── seeding ─────────────────────────────────────────────────────────────── */

let phoneSeq = 0;

export async function seedBusiness(): Promise<{ businessId: string; connectionId: string }> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481300${String(phoneSeq).padStart(5, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const connection = await withBusiness(appDb, business.id, (tx) =>
    paymentsHub.upsertConnection(tx, { businessId: business.id, providerType: 'paystack' }),
  );
  return { businessId: business.id, connectionId: connection.id };
}

let nextObjectId = 7_000_000;

/** Store an event byte-for-byte the way the ingress controller does. */
export async function storeEvent(
  body: { event: string; data: Record<string, unknown> },
  externalIdOverride?: string,
): Promise<string> {
  const externalId = externalIdOverride ?? `${body.data['id']}:${body.event}`;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: body.event,
    externalId,
    payload: sealPayload(body, config.vaultKey, 'paystack', externalId),
    businessId: null,
  });
  return storedEventId(recorded);
}

export function chargeSuccess(reference: string, amountK = 15_000_000, id = ++nextObjectId) {
  return {
    event: 'charge.success',
    data: { id, reference, amount: amountK, currency: 'NGN', status: 'success' },
  };
}

/** Paystack's refund envelope: the CHARGE it refunds rides in `transaction_reference`. */
export function refundEvent(
  reference: string,
  amountK: number,
  opts: { id?: number; status?: string; event?: string } = {},
) {
  const id = opts.id ?? ++nextObjectId;
  return {
    event: opts.event ?? 'refund.processed',
    data: {
      id,
      transaction_reference: reference,
      refund_reference: `RF-${id}`,
      amount: amountK,
      currency: 'NGN',
      status: opts.status ?? 'processed',
    },
  };
}

/** Paystack's dispute envelope: the charge rides in `transaction.reference`. */
export function disputeEvent(
  reference: string,
  amountK: number,
  opts: { id?: number; event?: string; status?: string; resolution?: string | null } = {},
) {
  const id = opts.id ?? ++nextObjectId;
  return {
    event: opts.event ?? 'charge.dispute.create',
    data: {
      id,
      refund_amount: amountK,
      currency: 'NGN',
      status: opts.status ?? 'awaiting-merchant-feedback',
      resolution: opts.resolution ?? null,
      transaction: { id: 1, reference, amount: amountK },
    },
  };
}

export const pump = () => pumpPaystackEvents({ workerDb, appDb, vaultKey: config.vaultKey });

export async function drainJobs(): Promise<number> {
  const runner = buildRunner(workerDb, appDb, deps);
  let ran = 0;
  while (await runner.runOnce()) ran += 1;
  return ran;
}

/** Book the obligation through the real pipeline: one charge, one payment. */
export async function bookPayment(businessId: string, reference: string, amountK = 15_000_000) {
  provider.willVerify(reference, { amountK });
  const eventId = await storeEvent(chargeSuccess(reference, amountK));
  await pump();
  await drainJobs();
  const idRows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM payments WHERE rekoda_reference = ${reference}`),
  );
  const paymentId = [...idRows][0]?.id;
  if (!paymentId) throw new Error('booking did not produce a payment');
  return { eventId, paymentId };
}

/** The provider pays the payment out: a SETTLED payout covering it (§20). */
export async function settle(
  businessId: string,
  connectionId: string,
  paymentId: string,
  amountK: number,
) {
  const outcome = await withBusiness(appDb, businessId, (tx) =>
    settlementsRepo.recordSettlement(tx, {
      businessId,
      paymentConnectionId: connectionId,
      providerSettlementId: `STL-${randomBytes(3).toString('hex')}`,
      status: 'SETTLED',
      grossK: amountK,
      netK: amountK,
      settledAt: new Date(),
      items: [{ paymentId, amountK }],
      components: [],
    }),
  );
  expect(outcome.outcome).toBe('recorded');
}

/* ── read-backs ──────────────────────────────────────────────────────────── */

export const invoiceState = (businessId: string, invoiceId: string) =>
  withBusiness(appDb, businessId, (tx) => issueRepo.invoiceForPayment(tx, businessId, invoiceId));

export const refundsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => refundsRepo.refundsFor(tx, businessId));

export const reversalsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => refundsRepo.reversalsFor(tx, businessId));

export const chargebacksOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => chargebacksRepo.chargebacksFor(tx, businessId));

export const reconciliationsOf = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => settleRepo.reconciliationsFor(tx));

export const paymentStatus = async (businessId: string, paymentId: string) => {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ status: string }>(sql`SELECT status FROM payments WHERE id = ${paymentId}::uuid`),
  );
  return [...rows][0]?.status;
};

export const standing = (businessId: string, paymentId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    settleRepo.standingAllocationsFor(tx, businessId, paymentId),
  );

export async function ledgerTotals(
  businessId: string,
): Promise<{ d: number; c: number; lines: number }> {
  const entries = await withBusiness(appDb, businessId, (tx) =>
    issueRepo.ledgerEntriesFor(tx, businessId),
  );
  return {
    d: entries.reduce((sum, e) => sum + Number(e.debitK), 0),
    c: entries.reduce((sum, e) => sum + Number(e.creditK), 0),
    lines: entries.length,
  };
}

export async function balanceByCode(businessId: string, code: string): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT coalesce(sum(e.debit_k - e.credit_k), 0)::bigint AS n
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.business_id = ${businessId}::uuid AND a.code = ${code}
    `),
  );
  return Number([...rows][0]!.n);
}

export async function balanceByRole(
  businessId: string,
  role: 'PAYMENT_PROVIDER_CLEARING' | 'PROVIDER_CHARGEBACK_PAYABLE',
  connectionId: string,
): Promise<number> {
  return withBusiness(appDb, businessId, async (tx) => {
    const account = await accountsRepo.accountByRole(tx, businessId, role, connectionId);
    if (!account) throw new Error(`no ${role} account`);
    const rows = await tx.execute<{ n: number }>(sql`
      SELECT coalesce(sum(debit_k - credit_k), 0)::bigint AS n
      FROM ledger_entries WHERE account_id = ${account.id}::uuid
    `);
    return Number([...rows][0]!.n);
  });
}

export const AR = '1100';
/** Chart code of the BANK_PAYSTACK ledger key ("Bank (Paystack settlements)");
 * 1020 is the generic bank account, which no Paystack posting touches. */
export const BANK_PAYSTACK = '1010';

export async function countRows(
  businessId: string,
  table: string,
  where = 'true',
): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)),
  );
  return Number([...rows][0]!.n);
}

export async function auditRows(businessId: string, action: string) {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ entity_id: string; new_value: Record<string, unknown> }>(sql`
      SELECT entity_id, new_value FROM audit_events
      WHERE business_id = ${businessId}::uuid AND entity = 'payment' AND action = ${action}
    `),
  );
  return [...rows];
}

/** Registers the suite hooks; call once at the top level of each suite. */
export function useAdjustmentsHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);
    ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
    ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));

    process.env['DATABASE_URL'] = urls.app;
    process.env['OTP_PEPPER'] = testKey('pepper');
    process.env['REKODA_API_SECRET'] = testKey('secret');
    process.env['VAULT_KEY'] = testKey('vault');
    process.env['MATCH_KEY'] = testKey('match');
    config = loadConfig();

    provider = new StubPaymentProvider();
    stubSender = new StubSender();
    deps = {
      gateway: new PrivacyGateway(appDb, config),
      interpreter: new Interpreter(appDb, config, StubTransport.answering({ intent: 'Unclear' })),
      replySender: new ReplySender(config, stubSender),
      storage: new LocalStorage(storageRoot),
      sender: stubSender,
      config,
      paymentProvider: provider,
      paymentIntents: new PaymentIntentsService(config, appDb, provider),
      stt: new StubSpeechToText(),
      ocr: new StubTextExtraction(),
      audioProbe: new ContainerAudioProbe(),
      commandBus: new CommandBus(new RiskPolicyService()),
    };
  });

  afterAll(async () => {
    await closeApp?.();
    await closeWorker?.();
  });

  beforeEach(async () => {
    await truncateAll(urls);
    provider.reset();
    stubSender.reset();
  });
}
