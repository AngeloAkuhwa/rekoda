/**
 * An overpayment recorded from the dashboard, in a real browser (G-49, OWN-16).
 *
 * The action tests proved the server's answer; what escaped them was the
 * BROWSER. React resets an uncontrolled form after a server action, so the
 * confirmation screen came back with the amount refilled to the balance and
 * the method back to cash while the question still named the merchant's
 * figure. "Yes, record it" then sent the balance, the action rightly treated
 * it as a different payment, and the excess vanished from the books. These
 * journeys pin what the merchant sees AND what lands in the database.
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
const freshPhone = () => `0815${RUN}${String(1000 + seq++).slice(-4)}`;

async function codeFor(page: Page): Promise<string> {
  const el = page.locator('[data-e2e-otp]');
  await expect(el).toHaveCount(1);
  return (await el.getAttribute('data-e2e-otp'))!;
}

/** Phone → code → business. Returns the business id, found by its unique name. */
async function onboard(page: Page): Promise<string> {
  const name = `Ada Overpay ${RUN}-${seq}`;
  await page.goto('/start');
  await page.fill('#phone', freshPhone());
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/verify/);
  await page.fill('#code', await codeFor(page));
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\/business$/);
  await page.fill('#name', name);
  await page.selectOption('#type', 'Fashion & clothing');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\/complete$/);
  const [row] = await sql<{ id: string }[]>`SELECT id FROM businesses WHERE name = ${name}`;
  return row!.id;
}

/**
 * A ₦150,000 invoice issued the way a merchant does it on the dashboard: a
 * quote, then "they said yes". Named when `customer` is given, so the
 * invoice is linked to a customer record; unlinked otherwise.
 */
async function invoiceFor(page: Page, naira: number, customer?: string): Promise<string> {
  /* A fresh load: the quote disclosures start closed, so a click opens them. */
  await page.goto('/app/invoices');
  await page.getByText('Send a new quote').click();
  if (customer) await page.fill('#quoteCustomer', customer);
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

/** Every row a payment writes, counted, for this business only. */
async function footprint(businessId: string) {
  const [row] = await sql<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}) AS payments,
      (SELECT count(*)::int FROM payment_allocations WHERE business_id = ${businessId}) AS allocations,
      (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}) AS receipts,
      (SELECT count(*)::int FROM customer_credits WHERE business_id = ${businessId}) AS credits,
      (SELECT count(*)::int FROM reconciliations WHERE business_id = ${businessId}) AS reconciliations,
      (SELECT count(*)::int FROM ledger_entries WHERE business_id = ${businessId}) AS ledger_entries`;
  return row!;
}

/**
 * Net (debit − credit) per ACCOUNT across the business's ledger, by chart
 * code: 1020 is the merchant's own bank, distinct from 1010 (Paystack
 * settlements), which also has the bank role and must stay untouched here.
 */
const LEDGER_CODES: Record<string, string> = {
  '1000': 'CASH',
  '1010': 'BANK_PAYSTACK',
  '1020': 'BANK',
  '1100': 'ACCOUNTS_RECEIVABLE',
  '2300': 'CUSTOMER_CREDIT',
};
async function nets(businessId: string): Promise<Record<string, number>> {
  const rows = await sql<{ code: string; net: string }[]>`
    SELECT a.code, sum(e.debit_k - e.credit_k)::text AS net
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
     WHERE e.business_id = ${businessId} AND a.code IN ${sql(Object.keys(LEDGER_CODES))}
     GROUP BY a.code`;
  return Object.fromEntries(rows.map((r) => [LEDGER_CODES[r.code]!, Number(r.net)]));
}

async function onlyPayment(businessId: string) {
  const [payment] = await sql<
    {
      id: string;
      amount_k: string;
      method: string;
      verified: number;
      initial_confirmation_source: string;
    }[]
  >`SELECT id, amount_k::text, method, verified::int, initial_confirmation_source
      FROM payments WHERE business_id = ${businessId}`;
  const [allocation] = await sql<{ amount_k: string }[]>`
    SELECT amount_k::text FROM payment_allocations WHERE business_id = ${businessId}`;
  const [receipt] = await sql<{ amount_k: string }[]>`
    SELECT amount_k::text FROM receipts WHERE business_id = ${businessId}`;
  return { payment: payment!, allocation: allocation!, receipt: receipt! };
}

async function invoiceRow(businessId: string, invoiceNumber: string) {
  const [row] = await sql<{ paid_k: string; balance_due_k: string; status: string }[]>`
    SELECT paid_k::text, balance_due_k::text, status FROM invoices
     WHERE business_id = ${businessId} AND invoice_number = ${invoiceNumber}`;
  return row!;
}

/** The payment card: its messages, never the quote forms' beside it. */
const card = (page: Page) =>
  page
    .locator('.rk-card')
    .filter({ has: page.getByRole('heading', { name: 'Money that came in' }) });
const amount = (page: Page) => page.locator('#payAmount');
const method = (page: Page) => page.locator('#payMethod');

/** The merchant's first submit: the figure they typed, the way it came in. */
async function askAbout(
  page: Page,
  invoiceNumber: string,
  naira: string,
  how: 'cash' | 'transfer',
) {
  await page.selectOption('#payInvoiceNumber', invoiceNumber);
  await page.selectOption('#payMethod', how);
  await amount(page).fill(naira);
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('alert')).toContainText('Nothing is saved until you confirm.');
}

test('a transfer overpayment keeps the typed amount and method, and books all of it', async ({
  page,
}) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);
  const before = await footprint(businessId);

  await askAbout(page, invoiceNumber, '180000', 'transfer');

  /* The question, and the form STILL holding what the merchant entered. */
  await expect(card(page).getByRole('alert')).toContainText(
    `${invoiceNumber} owes ₦150,000. You are recording ₦180,000: ₦150,000 settles the invoice and ₦30,000 is recorded as unapplied`,
  );
  await expect(amount(page)).toHaveValue('180000');
  await expect(method(page)).toHaveValue('transfer');
  await expect(page.getByRole('button', { name: 'Yes, record it' })).toBeVisible();
  expect(await footprint(businessId)).toEqual(before);

  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByRole('status')).toContainText('for ₦180,000');

  const { payment, allocation, receipt } = await onlyPayment(businessId);
  expect(payment).toMatchObject({
    amount_k: '18000000',
    method: 'transfer',
    verified: 0,
    initial_confirmation_source: 'MERCHANT_ATTESTED',
  });
  expect(allocation.amount_k).toBe('15000000');
  /* The receipt is for what came in, never just the part that settled. */
  expect(receipt.amount_k).toBe('18000000');
  expect(await invoiceRow(businessId, invoiceNumber)).toEqual({
    paid_k: '15000000',
    balance_due_k: '0',
    status: 'paid',
  });

  /* Unlinked: no customer credit, an overpaid exception instead. */
  expect(await footprint(businessId)).toMatchObject({
    payments: 1,
    allocations: 1,
    receipts: 1,
    credits: 0,
    reconciliations: 1,
  });
  const [recon] = await sql<
    { status: string; reason: string; expectation_kind: string; outstanding_k: string }[]
  >`SELECT status, reason, expectation_kind, outstanding_k::text FROM reconciliations
     WHERE business_id = ${businessId}`;
  expect(recon).toEqual({
    status: 'EXCEPTION',
    reason: 'overpaid',
    expectation_kind: 'invoice',
    outstanding_k: '-3000000',
  });

  /* The full ₦180,000 into the BANK (a transfer), never cash. */
  expect(await nets(businessId)).toEqual({
    BANK: 18_000_000,
    ACCOUNTS_RECEIVABLE: 0,
    CUSTOMER_CREDIT: -3_000_000,
  });
});

test('a named customer overpaying in cash gets the excess as their credit', async ({ page }) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000, 'Chiamaka Obi');

  await askAbout(page, invoiceNumber, '180000', 'cash');
  await expect(card(page).getByRole('alert')).toContainText('₦30,000 becomes customer credit');
  await expect(amount(page)).toHaveValue('180000');
  await expect(method(page)).toHaveValue('cash');
  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByRole('status')).toContainText('for ₦180,000');

  const { payment, allocation, receipt } = await onlyPayment(businessId);
  expect(payment.amount_k).toBe('18000000');
  expect(allocation.amount_k).toBe('15000000');
  expect(receipt.amount_k).toBe('18000000');
  const credits = await sql<{ amount_minor: string; source_type: string }[]>`
    SELECT amount_minor::text, source_type FROM customer_credits WHERE business_id = ${businessId}`;
  expect([...credits]).toEqual([{ amount_minor: '3000000', source_type: 'overpayment' }]);
  const [recon] = await sql<{ reason: string }[]>`
    SELECT reason FROM reconciliations WHERE business_id = ${businessId}`;
  expect(recon?.reason).toBe('overpaid');
  expect(await nets(businessId)).toEqual({
    CASH: 18_000_000,
    ACCOUNTS_RECEIVABLE: 0,
    CUSTOMER_CREDIT: -3_000_000,
  });
});

test('changing the amount after the question asks again instead of confirming', async ({
  page,
}) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);

  await askAbout(page, invoiceNumber, '180000', 'transfer');
  /* The merchant corrects the figure: this is not a yes to ₦180,000. */
  await amount(page).fill('190000');
  await expect(page.getByRole('button', { name: 'Record this payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('alert')).toContainText('You are recording ₦190,000');
  await expect(amount(page)).toHaveValue('190000');
  expect(await footprint(businessId)).toMatchObject({ payments: 0, receipts: 0 });

  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByRole('status')).toContainText('for ₦190,000');
  const { payment } = await onlyPayment(businessId);
  expect(payment.amount_k).toBe('19000000');
});

test('a confirmation made stale by another payment books nothing', async ({ page, context }) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);
  await askAbout(page, invoiceNumber, '180000', 'cash');

  /* Money lands from another tab while the merchant reads the question. */
  const other = await context.newPage();
  await other.goto('/app/invoices');
  await other.selectOption('#payInvoiceNumber', invoiceNumber);
  await other.locator('#payAmount').fill('50000');
  await other.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(other).getByRole('status')).toContainText('Recorded');
  const before = await footprint(businessId);

  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByText('now owes ₦100,000, not what you confirmed')).toBeVisible();
  expect(await footprint(businessId)).toEqual(before);
  expect(await invoiceRow(businessId, invoiceNumber)).toMatchObject({
    paid_k: '5000000',
    balance_due_k: '10000000',
  });
});

test('switching invoice still refills the amount from its balance', async ({ page }) => {
  await onboard(page);
  const first = await invoiceFor(page, 150_000);
  /* A second, smaller invoice to switch to. */
  const second = await invoiceFor(page, 40_000);

  await page.selectOption('#payInvoiceNumber', first);
  await expect(amount(page)).toHaveValue('150000');
  await page.selectOption('#payInvoiceNumber', second);
  await expect(amount(page)).toHaveValue('40000');
  await page.selectOption('#payInvoiceNumber', first);
  await expect(amount(page)).toHaveValue('150000');
});

test('after a payment commits, the next one starts fresh and is never "already recorded"', async ({
  page,
}) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);

  await page.selectOption('#payInvoiceNumber', invoiceNumber);
  await page.selectOption('#payMethod', 'transfer');
  await amount(page).fill('50000');
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('status')).toContainText('₦100,000 still owing');
  /* Refilled from the revalidated balance, method back to its default. */
  await expect(amount(page)).toHaveValue('100000');
  await expect(method(page)).toHaveValue('cash');

  /* A second, genuine payment: a new key, so it books. */
  await amount(page).fill('40000');
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('status')).toContainText('₦60,000 still owing');
  expect(await footprint(businessId)).toMatchObject({ payments: 2, receipts: 2 });
  expect(await invoiceRow(businessId, invoiceNumber)).toMatchObject({
    paid_k: '9000000',
    balance_due_k: '6000000',
  });
});

test('changing the method after the question asks again, and books the new method', async ({
  page,
}) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);

  await askAbout(page, invoiceNumber, '180000', 'transfer');
  /* A different payment now: no yes to the old question is offered. */
  await page.selectOption('#payMethod', 'cash');
  await expect(page.getByRole('button', { name: 'Record this payment' })).toBeVisible();
  await expect(card(page).getByRole('alert')).toHaveCount(0);

  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('alert')).toContainText('You are recording ₦180,000');
  await expect(method(page)).toHaveValue('cash');
  expect(await footprint(businessId)).toMatchObject({ payments: 0 });

  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByRole('status')).toContainText('for ₦180,000');
  const { payment } = await onlyPayment(businessId);
  expect(payment).toMatchObject({ amount_k: '18000000', method: 'cash' });
  expect(await nets(businessId)).toEqual({
    CASH: 18_000_000,
    ACCOUNTS_RECEIVABLE: 0,
    CUSTOMER_CREDIT: -3_000_000,
  });
});

test('a method changed while the question is on its way is never confirmed as the old one', async ({
  page,
}) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);

  /* Hold the action's answer back so the merchant can change the method
   * while the first request is still in flight. */
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/app/invoices', async (route) => {
    if (route.request().method() === 'POST') await held;
    await route.continue();
  });

  await page.selectOption('#payInvoiceNumber', invoiceNumber);
  await page.selectOption('#payMethod', 'transfer');
  await amount(page).fill('180000');
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await page.selectOption('#payMethod', 'cash');
  release();

  /* The answer was about a transfer; the form now says cash. No yes. */
  await expect(page.getByRole('button', { name: 'Record this payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, record it' })).toHaveCount(0);
  await page.unroute('**/app/invoices');
  expect(await footprint(businessId)).toMatchObject({ payments: 0 });

  /* Submitting asks about the cash payment, and only that is booked. */
  await page.getByRole('button', { name: 'Record this payment' }).click();
  await expect(card(page).getByRole('alert')).toContainText('You are recording ₦180,000');
  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByRole('status')).toContainText('for ₦180,000');
  const { payment } = await onlyPayment(businessId);
  expect(payment).toMatchObject({ amount_k: '18000000', method: 'cash' });
});

test('a submit before the page hydrates (a full form post) keeps the figures and books all of it', async ({
  page,
}) => {
  const businessId = await onboard(page);
  const invoiceNumber = await invoiceFor(page, 150_000);

  /* The app's script never loads: the streamed page still shows (its inline
   * reveal runs) but React never hydrates, so the form posts natively and
   * the answer comes back as a whole new page, as it does for a merchant
   * who submits before the script arrives on a slow connection. */
  await page.route('**/_next/static/chunks/**', (route) => route.abort());
  await page.goto('/app/invoices');
  await page.selectOption('#payInvoiceNumber', invoiceNumber);
  await page.selectOption('#payMethod', 'transfer');
  await amount(page).fill('180000');
  await page.getByRole('button', { name: 'Record this payment' }).click();

  await expect(card(page).getByRole('alert')).toContainText('You are recording ₦180,000');
  await expect(amount(page)).toHaveValue('180000');
  await expect(method(page)).toHaveValue('transfer');
  expect(await footprint(businessId)).toMatchObject({ payments: 0 });

  await page.getByRole('button', { name: 'Yes, record it' }).click();
  await expect(card(page).getByRole('status')).toContainText('for ₦180,000');
  const { payment, receipt } = await onlyPayment(businessId);
  expect(payment).toMatchObject({ amount_k: '18000000', method: 'transfer' });
  expect(receipt.amount_k).toBe('18000000');
});
