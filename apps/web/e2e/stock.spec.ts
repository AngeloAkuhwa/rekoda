/**
 * Stock, from an order to the shelf, in a real browser (G-28).
 *
 * The stock page is read-only by design: nothing is typed into it. Stock comes
 * in when goods are received against a purchase order, so the journey that
 * matters is the whole chain a merchant walks: an empty shelf, an order sent,
 * the goods marked received, then the shelf, its export and the ledger agree.
 * Received on credit (nothing paid) so the only money movement is stock in and
 * a supplier owed, and a half-recorded receipt shows up as an unbalanced pair.
 */
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const OWNER_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rekoda@127.0.0.1:5432/rekoda';
const sql = postgres(OWNER_DATABASE_URL, { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

/** Seven random digits behind this spec's own prefix, so a reused local database never repeats one. */
const issued = new Set<string>();
const freshPhone = (): string => {
  let phone: string;
  do {
    phone = `0807${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
  } while (issued.has(phone));
  issued.add(phone);
  return phone;
};

/** The business is named after its owner's phone, which is unique, so the id lookup below can only find this one. */
async function onboard(page: Page): Promise<string> {
  const phone = freshPhone();
  const name = `Stock Biz ${phone}`;
  await page.goto('/start');
  await page.fill('#phone', phone);
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

test('goods received against an order reach the shelf, the export and a balanced ledger', async ({
  page,
}) => {
  const businessId = await onboard(page);

  // Nothing counted yet: the page says how to start rather than showing an empty table.
  await page.goto('/app/stock');
  await expect(page.getByRole('heading', { name: 'What you have on hand' })).toBeVisible();
  await expect(page.getByText('You are not counting any stock yet')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);

  // Ask a supplier for ten at ₦5,000. Ordering is not owning: the shelf stays empty.
  await page.goto('/app/expenses');
  await page.getByText('Send a new purchase order').click();
  await page.fill('#poItem0', 'Ankara bale');
  await page.fill('#poQty0', '10');
  await page.fill('#poPrice0', '5000');
  await page.getByRole('button', { name: 'Save purchase order' }).click();
  await expect(page.getByRole('status').filter({ hasText: /./ }).first()).toBeVisible();
  await page.goto('/app/stock');
  await expect(page.getByText('You are not counting any stock yet')).toBeVisible();

  // The goods land, nothing paid yet.
  await page.goto('/app/expenses');
  await page.getByText('The goods landed: mark one received').click();
  await page.getByRole('button', { name: 'Mark received' }).click();
  await expect(page.getByRole('status').filter({ hasText: /./ }).first()).toBeVisible();

  // Now the shelf counts them, at what they cost.
  await page.goto('/app/stock');
  const row = page.getByRole('row').filter({ hasText: 'Ankara bale' });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole('cell');
  await expect(cells.nth(1)).toHaveText(/^10$/);
  await expect(cells.nth(2)).toHaveText(/^₦5,000$/);
  await expect(cells.nth(3)).toHaveText(/^In stock$/);
  await expect(page.getByText('One product counted')).toBeVisible();

  // The export is the same shelf.
  const csv = await page.request.get('/app/export/stock');
  expect(csv.ok()).toBe(true);
  expect(await csv.text()).toContain('Ankara bale');

  // One movement of +10, and the ledger took stock in against what is owed, equal and opposite.
  const moves = await sql<{ delta: string }[]>`
    SELECT delta::text FROM inventory_movements WHERE business_id = ${businessId}`;
  expect(moves.map((m) => m.delta)).toEqual(['10']);
  const entries = await sql<{ code: string; debit_k: string; credit_k: string }[]>`
    SELECT a.code, e.debit_k::text, e.credit_k::text
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
     WHERE e.business_id = ${businessId} ORDER BY a.code`;
  expect(entries).toEqual([
    { code: '1200', debit_k: String(50_000 * 100), credit_k: '0' },
    { code: '2000', debit_k: '0', credit_k: String(50_000 * 100) },
  ]);
});
