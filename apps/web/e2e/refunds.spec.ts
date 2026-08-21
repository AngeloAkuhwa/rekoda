/**
 * The refund and retention pages, in a real browser (ADR 0024).
 *
 * Both exist because a merchant needs to find their own situation without
 * arguing with a paragraph, so what this checks is that they are reachable,
 * that the table is really a table, and that no company fact was invented
 * where none is configured.
 */
import { expect, test } from '@playwright/test';

test('refunds is reachable from the footer and answers the common cases', async ({ page }) => {
  await page.goto('/pricing');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Refunds' }).click();

  await expect(page).toHaveURL(/\/refunds$/);
  await expect(page.getByRole('heading', { name: 'Refunds', level: 1 })).toBeVisible();

  // The cases a merchant actually arrives with.
  await expect(page.getByRole('cell', { name: /charged twice/ })).toBeVisible();
  await expect(
    page.getByRole('cell', { name: 'Full refund of the incorrect charge.' }),
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: /have not used any of it/ })).toBeVisible();

  // Never "all payments are non-refundable".
  await expect(page.getByText('non-refundable', { exact: true })).toHaveCount(0);
});

test('an unconfigured entity is a visible badge, never a plausible name', async ({ page }) => {
  await page.goto('/refunds');
  // The Fact badge renders the label plus "not set yet" rather than blank
  // space or a plausible-looking company name.
  await expect(page.getByText('Registered entity not set yet').first()).toBeVisible();
});

test('the retention schedule is published as a table with real periods', async ({ page }) => {
  await page.goto('/privacy#retention');

  await expect(page.getByRole('heading', { name: 'How long we keep it' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '6 years' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /90 days after it ends/ })).toBeVisible();
  // Voice is the one claim already true in code: transcribed, never stored.
  await expect(page.getByRole('cell', { name: 'Not kept' })).toBeVisible();
});
