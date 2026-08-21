/**
 * The Billing page, in a real browser (ADR 0024).
 *
 * A fresh business is on a trial with nothing charged, which is the state
 * every merchant starts in and the one most likely to be rendered wrong: no
 * cycle, no card, no history. What this proves is that the page is honest
 * about all three, that a plan change shows its price BEFORE it is
 * confirmed, and that confirming while card payments are gated charges
 * nothing and says so.
 */
import { expect, test, type Page } from '@playwright/test';

const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
const freshPhone = () => `0817${RUN}${String(1000 + seq++).slice(-4)}`;

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

test('a new merchant sees the trial, the meter and an empty history', async ({ page }) => {
  await onboard(page, freshPhone());

  await page
    .goto('/app')
    .then(() =>
      page
        .getByRole('navigation', { name: 'Dashboard sections' })
        .getByRole('link', { name: 'Billing' })
        .click(),
    );
  await expect(page).toHaveURL(/\/app\/billing$/);

  await expect(page.getByRole('heading', { name: 'Your plan and what it costs' })).toBeVisible();
  await expect(page.getByText('Free trial', { exact: true })).toBeVisible();
  await expect(page.getByText('No card needed', { exact: false })).toBeVisible();
  await expect(page.getByText('Nothing charged yet', { exact: false })).toBeVisible();

  // The meter is real: a trial gets 50 messages, and the page says so.
  await expect(page.getByText('of 50 messages used', { exact: false })).toBeVisible();
});

test('a plan change shows what it costs before it is confirmed', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/billing');

  // Three plans to move to, priced, with nothing committed by looking.
  await expect(page.getByRole('cell', { name: 'Rekoda Chat' })).toBeVisible();
  await page
    .getByRole('row', { name: /Rekoda Chat/ })
    .getByRole('link')
    .click();

  await expect(page).toHaveURL(/\/app\/billing\?to=chat$/);
  await expect(page.getByRole('heading', { name: 'Moving to Rekoda Chat' })).toBeVisible();
  // A first purchase is the full price, not a proration of a cycle that
  // never existed.
  await expect(page.getByText('₦9,900 today', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Confirm and pay' }).click();

  // Card payments are gated until the platform model is confirmed (spec §47).
  // The merchant is told plainly, and nothing was charged.
  await expect(page).toHaveURL(/problem=awaiting_platform_confirmation/);
  await expect(page.getByText('Nothing was charged', { exact: false })).toBeVisible();
  await expect(page.getByText('Free trial', { exact: true })).toBeVisible();
});

test('backing out of a plan change leaves the merchant where they were', async ({ page }) => {
  await onboard(page, freshPhone());
  await page.goto('/app/billing?to=complete');

  await expect(page.getByRole('heading', { name: 'Moving to Rekoda Complete' })).toBeVisible();
  await page.getByRole('link', { name: 'Not now' }).click();

  await expect(page).toHaveURL(/\/app\/billing$/);
  await expect(page.getByRole('heading', { name: 'Change plan' })).toBeVisible();
});
