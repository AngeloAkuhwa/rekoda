/**
 * The Reports page and the dashboard navigation, in a real browser.
 *
 * A fresh business has no ledger yet, so what this proves is the honest
 * shape: the tabs are there, the empty state explains itself, and the period
 * switcher moves without an error page.
 */
import { expect, test, type Page } from '@playwright/test';

const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
const freshPhone = () => `0816${RUN}${String(1000 + seq++).slice(-4)}`;

async function onboard(page: Page, phone: string) {
  await page.goto('/start');
  await page.fill('#phone', phone);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/verify/);
  const code = (await page.locator('[data-e2e-otp]').getAttribute('data-e2e-otp'))!;
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\/business$/);
  await page.fill('#name', 'Ada Fashion');
  await page.selectOption('#type', 'Fashion & clothing');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/setup\/complete$/);
}

test('the dashboard tabs reach every section', async ({ page }) => {
  await onboard(page, freshPhone());

  await page.goto('/app');
  const nav = () => page.getByRole('navigation', { name: 'Dashboard sections' });
  await expect(nav()).toBeVisible();

  await nav().getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/app\/reports$/);
  await expect(page.getByRole('heading', { name: 'Ada Fashion' })).toBeVisible();

  await nav().getByRole('link', { name: 'Invoices' }).click();
  await expect(page).toHaveURL(/\/app\/invoices$/);

  await nav().getByRole('link', { name: 'Receipts' }).click();
  await expect(page).toHaveURL(/\/app\/receipts$/);

  await nav().getByRole('link', { name: 'Audit' }).click();
  await expect(page).toHaveURL(/\/app\/audit$/);
  await expect(page.getByRole('heading', { name: 'Who changed what' })).toBeVisible();

  await nav().getByRole('link', { name: 'Expenses' }).click();
  await expect(page).toHaveURL(/\/app\/expenses$/);
  await expect(page.getByRole('heading', { name: 'Where the money went' })).toBeVisible();

  await nav().getByRole('link', { name: 'Stock' }).click();
  await expect(page).toHaveURL(/\/app\/stock$/);
  await expect(page.getByRole('heading', { name: 'What you have on hand' })).toBeVisible();

  await nav().getByRole('link', { name: 'Payments' }).click();
  await expect(page).toHaveURL(/\/app\/payments$/);

  await nav().getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test('the invoice and receipt registers explain themselves when empty', async ({ page }) => {
  await onboard(page, freshPhone());

  await page.goto('/app/invoices');
  await expect(page.getByRole('heading', { name: 'Everything you have billed' })).toBeVisible();
  await expect(page.getByText('No invoices yet')).toBeVisible();

  await page.goto('/app/receipts');
  await expect(page.getByRole('heading', { name: 'Proof of every payment' })).toBeVisible();
  await expect(page.getByText('No receipts yet')).toBeVisible();
});

test('the spend register explains itself when empty, and keeps stock apart', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/expenses');

  await expect(page.getByRole('heading', { name: 'Where the money went' })).toBeVisible();
  await expect(page.getByText('Nothing recorded yet')).toBeVisible();

  /* Three figures, never one. A shop that read a single "spent" number would
   * be reading its stock as a cost it has already borne. */
  await expect(page.getByText('Operating expenses')).toBeVisible();
  await expect(page.getByText('Stock purchases')).toBeVisible();
  await expect(page.getByText('Owed to suppliers')).toBeVisible();

  /* Same rule as the invoice register: a destructive control offered against
   * an empty list is an invitation to wonder what it would have done. */
  await expect(page.getByText('Withdraw an entry')).toHaveCount(0);
});

test('the audit trail says what it is, and that nothing can be removed', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/audit');

  await expect(page.getByRole('heading', { name: 'Who changed what' })).toBeVisible();
  await expect(page.getByText('Nothing recorded yet', { exact: false })).toBeVisible();

  /* The claim that makes the page worth showing anybody. If it ever stops
   * being true the words have to go first, so they are asserted. */
  await expect(page.getByText('only ever added', { exact: false })).toBeVisible();
});

test('an empty month says so instead of rendering zero statements', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/reports');
  await expect(page.getByRole('heading', { name: /No entries for/ })).toBeVisible();
  await expect(page.getByText('Statements build themselves')).toBeVisible();
});

test('the period switcher walks back a month and returns', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/reports');

  await page.getByRole('link', { name: /View/ }).click();
  await expect(page).toHaveURL(/\/app\/reports\?period=\d{4}-\d{2}$/);

  await page.getByRole('link', { name: 'This month →' }).click();
  await expect(page).toHaveURL(/\/app\/reports$/);
});

test('a garbage period falls back to this month, never an error page', async ({ page }) => {
  await onboard(page, freshPhone());
  const response = await page.goto('/app/reports?period=DROP%20TABLE');
  expect(response?.status()).toBe(200);
  // The page validates the parameter itself and quietly shows the current
  // month; the API's own 400 is pinned in the integration suite.
  await expect(page.getByRole('heading', { name: /No entries for/ })).toBeVisible();
});

/**
 * Voiding, from the register where a merchant notices the mistake.
 *
 * A fresh business has nothing to void, and the register says nothing about
 * voiding: a destructive control offered against an empty list is an invitation
 * to wonder what it would have done.
 */
test('the empty invoice register offers no way to void anything', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/invoices');

  await expect(page.getByText('No invoices yet', { exact: false })).toBeVisible();
  await expect(page.getByText('Void an invoice')).toHaveCount(0);
});
