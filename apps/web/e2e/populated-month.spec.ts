/**
 * A populated month, in a real browser (G-28).
 *
 * Every other register spec starts from an empty business and proves the empty
 * state. What nothing proved until now is the other half: after a merchant has
 * actually billed and been paid, do the registers, the debtors list and the
 * statements agree with each other and with the ledger? One business is driven
 * entirely through the dashboard forms, then each page is read back and the
 * database is asked the question the pages cannot ask of themselves: do the
 * posted entries balance.
 */
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const OWNER_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rekoda@127.0.0.1:5432/rekoda';
const sql = postgres(OWNER_DATABASE_URL, { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

/** Distinct from the other specs' ranges so parallel runs never collide. */
const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
const freshPhone = () => `0814${RUN}${String(1000 + seq++).slice(-4)}`;

async function onboard(page: Page, name: string): Promise<string> {
  await page.goto('/start');
  await page.fill('#phone', freshPhone());
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/verify/);
  const code = (await page.locator('[data-e2e-otp]').getAttribute('data-e2e-otp'))!;
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\/business$/);
  await page.fill('#name', name);
  await page.selectOption('#type', 'Fashion & clothing');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\/complete$/);
  const [row] = await sql<{ id: string }[]>`SELECT id FROM businesses WHERE name = ${name}`;
  return row!.id;
}

/** A quote, then "they said yes": the way a merchant issues an invoice on the dashboard. */
async function issueInvoice(page: Page, customer: string, naira: number): Promise<string> {
  await page.goto('/app/invoices');
  await page.getByText('Send a new quote').click();
  await page.fill('#quoteCustomer', customer);
  await page.fill('#quoteItem0', 'Lace wig');
  await page.fill('#quoteQty0', '1');
  await page.fill('#quotePrice0', String(naira));
  await page.getByRole('button', { name: 'Save quote' }).click();
  await expect(page.locator('#convertQuoteNumber option')).not.toHaveCount(0);

  await page.getByText('They said yes: convert one').click();
  await page.getByRole('button', { name: 'Convert to invoice' }).click();
  const option = page.locator('#payInvoiceNumber option', {
    hasText: `₦${naira.toLocaleString('en-NG')} owing`,
  });
  await expect(option).toHaveCount(1);
  return (await option.getAttribute('value'))!;
}

const card = (page: Page) =>
  page
    .locator('.rk-card')
    .filter({ has: page.getByRole('heading', { name: 'Money that came in' }) });

/** A cash payment of exactly `naira` (never more than the balance, so no overpayment question). */
async function payCash(page: Page, invoiceNumber: string, naira: number) {
  await page.selectOption('#payInvoiceNumber', invoiceNumber);
  await page.selectOption('#payMethod', 'cash');
  await page.locator('#payAmount').fill(String(naira));
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('status')).toContainText('Recorded');
}

test('a billed and part-paid month reads the same on every page and in the ledger', async ({
  page,
}) => {
  const name = `Ada Month ${RUN}-${seq}-${Date.now()}`;
  const businessId = await onboard(page, name);

  // Invoice A is paid in full, invoice B only in part.
  const invoiceA = await issueInvoice(page, 'Ngozi Stores', 200_000);
  await payCash(page, invoiceA, 200_000);
  const invoiceB = await issueInvoice(page, 'Bayo Traders', 80_000);
  await payCash(page, invoiceB, 30_000);

  // The invoice register lists both, and says what is still owing on B.
  await page.goto('/app/invoices');
  await expect(page.getByText('No invoices yet')).toHaveCount(0);
  await expect(page.getByText(invoiceA).first()).toBeVisible();
  await expect(page.getByText(invoiceB).first()).toBeVisible();
  // The register row itself says what is still owing on B, not just that B exists.
  const register = page
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Balance' }) });
  await expect(register.getByRole('row').filter({ hasText: invoiceB })).toContainText('₦50,000');

  // One immutable receipt per accepted payment, part payments included: ₦200,000 and ₦30,000.
  await page.goto('/app/receipts');
  await expect(page.getByText('No receipts yet')).toHaveCount(0);
  const receipts = page
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Invoice' }) });
  await expect(receipts.getByRole('row').filter({ hasText: invoiceA })).toContainText('₦200,000');
  await expect(receipts.getByRole('row').filter({ hasText: invoiceB })).toContainText('₦30,000');
  await expect(page.getByText('2 receipts all time', { exact: true })).toBeVisible();

  // The debtors list shows exactly what is still owed, and not the settled invoice.
  await page.goto('/app/debtors');
  await expect(page.getByText('Nobody owes you anything right now')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: invoiceB })).toContainText('₦50,000');
  await expect(page.getByText(invoiceA)).toHaveCount(0);

  // The statements are built, not the empty month.
  await page.goto('/app/reports');
  await expect(page.getByRole('heading', { name: /No entries for/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Profit and loss' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Balance sheet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trial balance' })).toBeVisible();
  // Both invoices were billed this month: ₦280,000 of income, read in the profit and loss itself.
  const profitAndLoss = page
    .locator('.rk-card')
    .filter({ has: page.getByRole('heading', { name: 'Profit and loss' }) });
  await expect(profitAndLoss.getByRole('row', { name: /Total income/ })).toContainText('₦280,000');

  // The statement fits a phone with no sideways scroll.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // The database agrees with the pages: ₦50,000 receivable, and every posting balances.
  const [books] = await sql<{ debit: string; credit: string; receivable: string }[]>`
    SELECT sum(e.debit_k)::text AS debit, sum(e.credit_k)::text AS credit,
           coalesce(sum(e.debit_k - e.credit_k) FILTER (WHERE a.code = '1100'), 0)::text AS receivable
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
     WHERE e.business_id = ${businessId}`;
  // Balanced journal by journal: two opposite imbalances would cancel in a business-wide sum.
  const unbalanced = await sql<{ transaction_id: string }[]>`
    SELECT transaction_id FROM ledger_entries
     WHERE business_id = ${businessId}
     GROUP BY transaction_id
    HAVING sum(debit_k) <> sum(credit_k)`;
  expect(unbalanced).toEqual([]);
  expect(books!.debit).toBe(books!.credit);
  expect(Number(books!.receivable)).toBe(50_000 * 100);
});
