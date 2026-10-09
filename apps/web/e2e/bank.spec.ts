/**
 * Releasing a classification, in a real browser (G-95, OD-24).
 *
 * The release reverses the entry Rekoda wrote for the classification, and
 * after it the line is unmatched again, so the cell that shows the sentence
 * is no longer the one that had the Release button. What this pins is that
 * the merchant is still TOLD what happened to their books.
 */
import { expect, test, type Page } from '@playwright/test';

/** Distinct from the other specs' ranges so parallel runs never collide. */
const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
const freshPhone = () => `0818${RUN}${String(1000 + seq++).slice(-4)}`;

async function codeFor(page: Page): Promise<string> {
  const el = page.locator('[data-e2e-otp]');
  await expect(el).toHaveCount(1);
  return (await el.getAttribute('data-e2e-otp'))!;
}

async function submit(page: Page) {
  await page.click('button[type=submit]');
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

test('releasing a classification says its entry was reversed', async ({ page }) => {
  await onboard(page, freshPhone());

  await page.goto('/app/bank');
  await page.setInputFiles('#statement', {
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date,Description,Amount\n03/08/2026,TRF FROM ADEBAYO O,150000.00\n'),
  });
  await page.getByRole('button', { name: /Read this statement|Reading/ }).click();
  await expect(page.getByText(/^Read 1 line from your bank\./)).toBeVisible();

  // Nothing in the books explains it, so the merchant says what it was.
  await page.getByRole('button', { name: /^Record .+ as what you chose$/ }).click();
  const release = page.getByRole('button', { name: /^Release the match on / });
  await expect(release).toBeVisible();

  await release.click();
  await expect(
    page.getByText(
      'Released. Rekoda reversed the classification entry and left the bank line unmatched so you can classify it again.',
    ),
  ).toBeVisible();
  // And the line is open again, to be classified afresh.
  await expect(page.getByRole('button', { name: /^Record .+ as what you chose$/ })).toBeVisible();
});

/* An ordinary entry paired, released, paired again and released again: the
 * second release must say what it did too, not stay silent because an
 * earlier pairing in the same cell succeeded. */
test('every release of an ordinary match says the entry is untouched', async ({ page }) => {
  await onboard(page, freshPhone());

  await page.goto('/app/reports');
  // The journal form sits in a closed <details> until asked for.
  await page.locator('summary', { hasText: 'Move money, or fix an entry' }).click();
  await page.fill('#amount', '150000');
  await page.selectOption('#outOf', 'OWNERS_EQUITY');
  await page.selectOption('#into', 'BANK');
  await page.fill('#memo', 'Savings into the business account');
  await page.fill('#occurredOn', '2026-08-03');
  await page.getByRole('button', { name: /Record this correction|Recording/ }).click();
  await expect(page.getByText(/^Recorded as JNL-/)).toBeVisible();

  await page.goto('/app/bank');
  await page.setInputFiles('#statement', {
    name: 'statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Date,Description,Amount\n03/08/2026,TRF FROM ADEBAYO O,150000.00\n'),
  });
  await page.getByRole('button', { name: /Read this statement|Reading/ }).click();
  await expect(page.getByText(/^Read 1 line from your bank\./)).toBeVisible();

  const pair = page.getByRole('button', { name: /^Match .+ to the chosen entry$/ });
  const release = page.getByRole('button', { name: /^Release the match on / });
  const untouched = page.getByText(
    'Released. The bank line and the existing entry are unmatched again.',
  );

  await pair.click();
  await release.click();
  await expect(untouched).toBeVisible();

  await pair.click();
  await expect(release).toBeVisible();
  await expect(untouched).toHaveCount(0);
  await release.click();
  await expect(untouched).toBeVisible();
});
