/**
 * The Payments page, in a real browser (docs/payments-v1.md §3–5, §35).
 *
 * The assertions that matter are about the account NUMBER: it is typed once
 * into the form and must never appear in the page again — not in the pending
 * state, not in the DOM, not after a reload. The masked last4 is the only
 * trace a browser ever holds after submit.
 */
import { expect, test, type Page } from '@playwright/test';

const ACCOUNT_NUMBER = '0123456789';

/** Distinct from onboarding.spec's range so parallel runs never collide. */
const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
const freshPhone = () => `0813${RUN}${String(1000 + seq++).slice(-4)}`;

async function codeFor(page: Page): Promise<string> {
  const el = page.locator('[data-e2e-otp]');
  await expect(el).toHaveCount(1);
  return (await el.getAttribute('data-e2e-otp'))!;
}

async function submit(page: Page) {
  await page.click('button[type=submit]');
}

/**
 * The connect form's own button, by name: the dashboard header's Sign out is
 * also a submit button and comes first in the DOM, so the generic selector
 * would sign the merchant out instead of saving the form.
 */
async function saveConnection(page: Page) {
  await page.getByRole('button', { name: /Save my account|Saving/ }).click();
}

/** Phone → code → business, leaving the browser signed in. */
async function onboard(page: Page, phone: string) {
  await page.goto('/start');
  await page.fill('#phone', phone);
  await submit(page);
  await expect(page).toHaveURL(/\/verify/);
  await page.fill('#code', await codeFor(page));
  await submit(page);
  await expect(page).toHaveURL(/\/setup\/business$/);
  await page.fill('#name', 'Ada Fashion');
  await page.selectOption('#type', 'Fashion & clothing');
  await submit(page);
  await expect(page).toHaveURL(/\/setup\/complete$/);
}

test('settlement details go in once and only the mask ever comes back', async ({ page }) => {
  await onboard(page, freshPhone());

  await page.goto('/app/payments');
  await expect(
    page.getByRole('heading', { name: 'Get paid straight to your bank' }),
  ).toBeVisible();

  await page.selectOption('#bankCode', '058'); // GTBank
  await page.fill('#accountNumber', ACCOUNT_NUMBER);
  await page.fill('#accountName', 'Ada Fashion Ventures');
  await saveConnection(page);

  // No provider key in this environment, so the honest state is "saved,
  // activation pending" — shown with the mask, never the number.
  await expect(page.getByText('•••• 6789')).toBeVisible();
  await expect(page.getByRole('heading', { name: /being set up/i })).toBeVisible();
  expect(await page.content()).not.toContain(ACCOUNT_NUMBER);

  // A reload re-renders from the API's masked view; still no number.
  await page.reload();
  await expect(page.getByText('•••• 6789')).toBeVisible();
  expect(await page.content()).not.toContain(ACCOUNT_NUMBER);
});

test('a 9-digit account number is corrected in plain words', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/payments');

  await page.selectOption('#bankCode', '058');
  await page.fill('#accountNumber', '123456789');
  await page.fill('#accountName', 'Ada Fashion Ventures');
  await saveConnection(page);

  await expect(page.getByText('Account numbers have 10 digits')).toBeVisible();
});

test('the empty payments page tells the truth instead of showing zeros', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/payments');

  await expect(page.getByRole('heading', { name: 'Verified payments' })).toBeVisible();
  await expect(page.getByText('None yet.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs your attention' })).toBeVisible();
});
