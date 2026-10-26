/**
 * Catalogue to storefront, in a real browser (G-28).
 *
 * The shop page is the one surface of Rekoda a merchant's customer sees, so it
 * is the one whose promises are worth reading from the customer's side: only a
 * priced product appears, an unpublished or closed shop is not there, and the
 * page fits a phone. One business is driven through the dashboard forms; the
 * shop is then opened in a SEPARATE browser context with no session, because a
 * page that only works for the signed-in owner is not a public page.
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
const freshPhone = () => `0809${RUN}${String(1000 + seq++).slice(-4)}`;

async function onboard(page: Page, name: string): Promise<void> {
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
}

/** A product typed on the dashboard; an empty price leaves it unpriced. */
async function addProduct(page: Page, name: string, naira: string) {
  await page.goto('/app/catalogue');
  await page.getByText('Add a product', { exact: true }).click();
  await page.fill('#newProductName', name);
  await page.fill('#newProductPrice', naira);
  await page.getByRole('button', { name: 'Add product' }).click();
  // The first product swaps the empty state for the table, so the form's own confirmation goes
  // with it; the row is the evidence either way.
  await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
}

/** Lists a product in the shop; a new product starts hidden. */
async function listInShop(page: Page, product: string) {
  await page.goto('/app/catalogue');
  await page.getByText('Take something out of the shop, or put it back').click();
  // The option's label carries the price and the count as well as the name.
  const option = page.locator('#listing-product option', { hasText: product });
  await page.selectOption('#listing-product', (await option.getAttribute('value'))!);
  await page.selectOption('#active', 'list');
  const form = page.locator('form').filter({ has: page.locator('#listing-product') });
  await form.getByRole('button').click();
  await expect(form.getByRole('status')).toBeVisible();
}

async function saveShop(page: Page, slug: string, shopName: string, open: boolean) {
  await page.goto('/app/catalogue');
  await page.getByText(/Set up your shop|Change your shop/).click();
  await page.fill('#slug', slug);
  await page.fill('#displayName', shopName);
  await page.selectOption('#published', open ? 'yes' : 'no');
  await page.getByRole('button', { name: 'Save shop' }).click();
}

test('a priced, listed product reaches an anonymous customer, and closing the shop removes it', async ({
  page,
  browser,
}) => {
  const stamp = `${RUN}${seq}${Date.now().toString(36)}`.toLowerCase();
  const slug = `ada-${stamp}`;
  const shopName = `Ada Wax ${stamp}`;
  await onboard(page, `Ada Shop ${stamp}`);

  await addProduct(page, 'Ankara bale', '8500');
  await addProduct(page, 'Unpriced sample', '');
  await listInShop(page, 'Ankara bale');
  // Listing an unpriced product is allowed on the dashboard; the shop must still leave it out.
  await listInShop(page, 'Unpriced sample');

  // Draft first: saved and closed, so a customer still gets the not-found page.
  await saveShop(page, slug, shopName, false);
  await expect(page.getByRole('status').filter({ hasText: 'Saved and closed' })).toBeVisible();

  const customer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const shopPage = await customer.newPage();
  try {
    await shopPage.goto(`/s/${slug}`);
    await expect(
      shopPage.getByRole('heading', { name: 'This shop is not here any more' }),
    ).toBeVisible();

    // Open it: the customer, with no session, sees the shop and only the priced, listed product.
    await saveShop(page, slug, shopName, true);
    await expect(page.getByRole('status').filter({ hasText: `/s/${slug}` })).toBeVisible();

    await shopPage.goto(`/s/${slug}`);
    await expect(shopPage.getByRole('heading', { level: 1, name: shopName })).toBeVisible();
    const item = shopPage.locator('.rk-shop-item').filter({ hasText: 'Ankara bale' });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('₦8,500');
    await expect(shopPage.getByText('Unpriced sample')).toHaveCount(0);

    // The one control a customer uses answers, and the page fits a phone.
    await item.getByRole('button', { name: 'Add to order' }).click();
    await expect(item.getByRole('button', { name: 'Added' })).toBeVisible();
    const overflow = await shopPage.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // Nothing the customer can read names the business behind the shop.
    const html = await shopPage.content();
    const [business] = await sql<{ id: string }[]>`
      SELECT business_id AS id FROM shops WHERE slug = ${slug}`;
    expect(business).toBeDefined();
    expect(html).not.toContain(business!.id);

    // Closing the shop takes it off the internet again: one change, as the dashboard promises.
    await saveShop(page, slug, shopName, false);
    await expect(page.getByRole('status').filter({ hasText: 'Saved and closed' })).toBeVisible();
    await shopPage.goto(`/s/${slug}`);
    await expect(
      shopPage.getByRole('heading', { name: 'This shop is not here any more' }),
    ).toBeVisible();
    await expect(shopPage.getByText('Ankara bale')).toHaveCount(0);
  } finally {
    await customer.close();
  }
});

test('a shop that was never made answers not-found, not an error', async ({ page }) => {
  await page.goto(`/s/never-made-${RUN}-${Date.now().toString(36)}`);
  await expect(page.getByRole('heading', { name: 'This shop is not here any more' })).toBeVisible();
});
