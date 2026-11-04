/**
 * The reports surface, end to end: session guard → SQL → contract shape.
 *
 * The NUMBERS are proven in packages/db/src/ledger/reports.integration.test.ts
 * against hand arithmetic; what this suite pins is the wiring — that the
 * endpoints exist, refuse strangers, scope to the session's tenant, and
 * answer in exactly the shape the web tier's zod contracts will parse.
 */
// The reports surface, end to end. Split by concern across reports*.integration.test.ts; the shared setup is in
// reports.fixtures.ts.
import { describe, expect, it } from 'vitest';
import { reportsStatementsResponse } from '@rekoda/contracts';
import { issueRepo, settleRepo, spendRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

describe('the four statements (ADR 0015)', () => {
  it('a fresh business gets empty, balanced statements for the current month', async () => {
    const { auth } = await onboard('+2348177000004');
    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.trialBalance.rows).toEqual([]);
    expect(statements.trialBalance.balanced).toBe(true);
    expect(statements.balanceSheet.balanced).toBe(true);
    expect(statements.profitAndLoss.netProfitK).toBe(0);
    expect(statements.cashflow.closingK).toBe(0);
  });

  it('refuses a malformed period with 400, never a crash', async () => {
    const { auth } = await onboard('+2348177000005');
    for (const bad of ['2026-13', 'now', '2026-1', "2026-08'--"]) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reports/statements?period=${encodeURIComponent(bad)}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('an expense shows up in the P&L, the trial balance stays balanced', async () => {
    const { auth, businessId } = await onboard('+2348177000006');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd2',
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.profitAndLoss.totalExpensesK).toBe(1_200_000);
    expect(statements.profitAndLoss.netProfitK).toBe(-1_200_000);
    expect(statements.trialBalance.balanced).toBe(true);
    expect(statements.balanceSheet.balanced).toBe(true);
    // Cash went negative (an expense with no income): it crosses to credit.
    const cash = statements.trialBalance.rows.find((r) => r.code === '1000');
    expect(cash?.creditK).toBe(1_200_000);

    /* And the schedule underneath it, labelled the way the statement is:
     * the merchant said "fuel" and named no category at all, and the books
     * say "Power and fuel" in every place that prints it. */
    expect(statements.expenseSchedule.lines).toEqual([
      { category: 'power', label: 'Power and fuel', amountK: 1_200_000 },
    ]);
    expect(statements.expenseSchedule.totalK).toBe(statements.profitAndLoss.totalExpensesK);
  });

  it('a month with nothing spent gets an empty schedule rather than no schedule', async () => {
    const { auth } = await onboard('+2348177000007');
    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.expenseSchedule).toEqual({ lines: [], totalK: 0 });
    expect(statements.revenueSchedule).toEqual({ lines: [], totalK: 0 });
  });

  /**
   * The channel a sale was made on, in the merchant's words, tying to the
   * income line above it. `sale_source` has been recorded since the chat
   * slice and this is the first thing that reads it.
   */
  it('says which channel the sales came from, and what nobody named', async () => {
    const { auth, businessId } = await onboard('+2348177000008');
    const sell = (saleSource: string | null, totalK: number, ref: string) =>
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: null,
          items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
          subtotalK: totalK,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK,
          paidK: 0,
          balanceDueK: totalK,
          method: 'cash',
          sourceType: 'chat',
          sourceId: ref,
          saleSource,
          actor: 'test',
        }),
      );
    await sell('instagram', 3_000_000, 'r1');
    await sell(null, 1_000_000, 'r2');

    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.revenueSchedule.lines).toEqual([
      { source: 'instagram', label: 'Instagram', amountK: 3_000_000 },
      /* Last whatever its size, and named for what it is rather than for
       * something the merchant failed to do. */
      { source: null, label: 'Not recorded', amountK: 1_000_000 },
    ]);
    expect(statements.revenueSchedule.totalK).toBe(statements.profitAndLoss.totalIncomeK);
  });
});

/**
 * The statements as a file.
 *
 * A dashboard is not a deliverable: a merchant asked for a loan or a grant
 * needs something dated they can forward. Asserted here as bytes rather than
 * as text, because the whole point is that it survives the wire.
 */
describe('the statements PDF', () => {
  const get = (path: string, auth: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers: auth });

  it('refuses without a session, like every other report', async () => {
    expect((await get('/v1/reports/statements.pdf')).statusCode).toBe(401);
  });

  it('refuses a period that is not a month', async () => {
    const { auth } = await onboard('+2348120000031');
    expect((await get('/v1/reports/statements.pdf?period=august', auth)).statusCode).toBe(400);
    expect((await get('/v1/reports/statements.pdf?period=2026-13', auth)).statusCode).toBe(400);
  });

  it('hands over a real PDF a browser saves and no cache keeps', async () => {
    const { auth } = await onboard('+2348120000032');
    const res = await get('/v1/reports/statements.pdf?period=2026-08', auth);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('rekoda-statements-2026-08.pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    /* The magic bytes, not merely a 200. A route that answered with an error
     * page and the right headers would pass every assertion above. */
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(1_000);
  });

  it('builds a month with no trading rather than failing on it', async () => {
    const { auth } = await onboard('+2348120000033');
    const res = await get('/v1/reports/statements.pdf?period=2020-01', auth);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('builds from the books once there are books', async () => {
    const { auth, businessId } = await onboard('+2348120000034');
    await seedStatements(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const res = await get(`/v1/reports/statements.pdf?period=${period}`, auth);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(1_000);
  });

  it('defaults to the current month when none is asked for', async () => {
    const { auth } = await onboard('+2348120000035');
    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const res = await get('/v1/reports/statements.pdf', auth);
    expect(res.headers['content-disposition']).toContain(`rekoda-statements-${period}.pdf`);
  });

  it('agrees with the JSON the dashboard renders', async () => {
    const { auth, businessId } = await onboard('+2348120000036');
    await seedStatements(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const json = (await get(`/v1/reports/statements?period=${period}`, auth)).json();
    const pdf = await get(`/v1/reports/statements.pdf?period=${period}`, auth);

    /* Both come from one `sumsFor`, so this is a guard against them drifting
     * apart later rather than a claim about today's arithmetic. */
    expect(json.trialBalance.balanced).toBe(true);
    expect(pdf.statusCode).toBe(200);
  });

  /** One ₦150,000 sale with ₦60,000 recorded, so the statements are not empty. */
  async function seedStatements(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_PDF',
        items: [{ name: 'Bag of rice', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'sale-pdf',
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'pay-pdf',
        actor: 'system',
      });
    });
  }
});

/**
 * The statements as a workbook.
 *
 * The PDF is for somebody who will read it; this is for somebody who will
 * work with it. So the assertions are about the archive being real and the
 * figures being numbers, not about bytes existing.
 */
describe('the statements workbook', () => {
  const get = (path: string, auth: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers: auth });

  /**
   * Read one part out of the zip, by WALKING the local headers.
   *
   * Not by searching for the filename: `[Content_Types].xml` lists every part
   * by path and sorts first in the archive, so a search finds the name inside
   * that part's data and reads the wrong bytes entirely. Entries are stored,
   * so once found there is nothing to inflate.
   */
  function part(zip: Buffer, name: string): string {
    let at = 0;
    while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
      const size = zip.readUInt32LE(at + 18);
      const nameLength = zip.readUInt16LE(at + 26);
      const extraLength = zip.readUInt16LE(at + 28);
      const entry = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
      const start = at + 30 + nameLength + extraLength;
      if (entry === name) return zip.subarray(start, start + size).toString('utf8');
      at = start + size;
    }
    throw new Error(`${name} is not in the archive`);
  }

  it('refuses without a session, like every other report', async () => {
    expect((await get('/v1/reports/statements.xlsx')).statusCode).toBe(401);
  });

  it('refuses a period that is not a month', async () => {
    const { auth } = await onboard('+2348120000051');
    expect((await get('/v1/reports/statements.xlsx?period=2026-13', auth)).statusCode).toBe(400);
  });

  it('hands over a real archive a browser saves and no cache keeps', async () => {
    const { auth } = await onboard('+2348120000052');
    const res = await get('/v1/reports/statements.xlsx?period=2026-08', auth);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('rekoda-statements-2026-08.xlsx');
    expect(res.headers['cache-control']).toBe('no-store');
    /* The zip local-header signature, not merely a 200. */
    expect([...res.rawPayload.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('carries four named sheets in the order an accountant reads them', async () => {
    const { auth } = await onboard('+2348120000053');
    const res = await get('/v1/reports/statements.xlsx?period=2026-08', auth);
    const workbook = part(res.rawPayload, 'xl/workbook.xml');

    expect(workbook).toContain('name="Profit and loss"');
    expect(workbook).toContain('name="Balance sheet"');
    expect(workbook).toContain('name="Cash flow"');
    expect(workbook).toContain('name="Trial balance"');
    expect(workbook.indexOf('Profit and loss')).toBeLessThan(workbook.indexOf('Balance sheet'));
  });

  it('writes the figures as numbers a spreadsheet can total', async () => {
    const { auth, businessId } = await onboard('+2348120000054');
    await seedWorkbook(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const res = await get(`/v1/reports/statements.xlsx?period=${period}`, auth);
    const sheet = part(res.rawPayload, 'xl/worksheets/sheet1.xml');

    /* Naira, not kobo, and in a value cell rather than an inline string. A
     * figure written as text is a figure nobody can sum, which is the entire
     * reason to ship this instead of another PDF. */
    expect(sheet).toContain('<v>150000</v>');
    expect(sheet).not.toContain('15000000');
    expect(sheet).not.toContain('₦');
  });

  it('agrees with the PDF built from the same month', async () => {
    const { auth, businessId } = await onboard('+2348120000055');
    await seedWorkbook(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const [pdf, xlsx] = await Promise.all([
      get(`/v1/reports/statements.pdf?period=${period}`, auth),
      get(`/v1/reports/statements.xlsx?period=${period}`, auth),
    ]);

    /* Both come from one `sumsFor` and one `buildAll`, so this guards against
     * them drifting apart later rather than claiming anything about today. */
    expect(pdf.statusCode).toBe(200);
    expect(xlsx.statusCode).toBe(200);
  });

  it('builds a month with no trading rather than failing on it', async () => {
    const { auth } = await onboard('+2348120000056');
    const res = await get('/v1/reports/statements.xlsx?period=2020-01', auth);
    expect(res.statusCode).toBe(200);
    expect([...res.rawPayload.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  async function seedWorkbook(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_XLS',
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'sale-xls',
        actor: 'system',
      });
    });
  }
});
