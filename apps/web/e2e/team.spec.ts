/**
 * Who can do what, in a real browser (G-28).
 *
 * The role matrix is enforced at the API (roles.integration.test.ts proves it
 * door by door). What nothing proved is the other half: that a person who is
 * actually invited, signs in on their own phone and opens the dashboard sees
 * the screen their role deserves, and that removing them takes it away. One
 * owner invites an accountant and a helper; each signs in in a separate
 * browser context, because two people never share a session.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

/** Distinct from the other specs' ranges so parallel runs never collide. */
const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
/** `prefix` keeps the owner, accountant and helper numbers apart within one run. */
/** The team table shows numbers the way the API stores them, with the country code. */
const e164 = (local: string) => `+234${local.slice(1)}`;
const phone = (prefix: string) => `${prefix}${RUN}${String(1000 + seq++).slice(-4)}`;

async function onboardOwner(page: Page, ownerPhone: string, name: string): Promise<void> {
  await page.goto('/start');
  await page.fill('#phone', ownerPhone);
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

/** An invited member signs in on their own phone and lands in the dashboard, not in setup. */
async function signInMember(browser: Browser, memberPhone: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/start');
  await page.fill('#phone', memberPhone);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/verify/);
  const code = (await page.locator('[data-e2e-otp]').getAttribute('data-e2e-otp'))!;
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/app/);
  return page;
}

async function submitInvite(page: Page, memberPhone: string, role: 'accountant' | 'delegate') {
  await page.goto('/app/team');
  await page.fill('#phone', memberPhone);
  await page.selectOption('#role', role);
  await page.getByRole('button', { name: 'Add them' }).click();
}

async function invite(page: Page, memberPhone: string, role: 'accountant' | 'delegate') {
  await submitInvite(page, memberPhone, role);
  await expect(page.getByRole('status').filter({ hasText: 'Added.' })).toBeVisible();
}

test('invited people see the screens their role allows, and removing one takes it away', async ({
  page,
  browser,
}) => {
  const stamp = `${RUN}${seq}${Date.now().toString(36)}`;
  const accountantPhone = phone('0805');
  const helperPhone = phone('0805');
  await onboardOwner(page, phone('0805'), `Team Biz ${stamp}`);

  await invite(page, accountantPhone, 'accountant');

  // The owner's table names the accountant in the words a merchant uses, and marks the owner.
  const people = page
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Phone' }) });
  await expect(people.getByRole('row').filter({ hasText: e164(accountantPhone) })).toContainText(
    'Accountant, can read everything',
  );
  await expect(people.getByText('that is you')).toHaveCount(1);

  // A trial includes one team member besides the owner: a second is refused, plainly, and nothing
  // is added.
  await submitInvite(page, helperPhone, 'delegate');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your plan includes 1 team member besides you' }),
  ).toBeVisible();
  await expect(people.getByRole('row').filter({ hasText: e164(helperPhone) })).toHaveCount(0);

  // The accountant reads everything but changes nothing in the catalogue and cannot see the team.
  const accountant = await signInMember(browser, accountantPhone);
  try {
    await accountant.goto('/app/team');
    await expect(
      accountant.getByText('Only the business owner can see and change who has access'),
    ).toBeVisible();
    await expect(accountant.getByRole('button', { name: 'Add them' })).toHaveCount(0);
    await accountant.goto('/app/catalogue');
    await expect(accountant.getByRole('heading', { name: 'Your products' })).toBeVisible();
    await expect(accountant.getByText('Add a product', { exact: true })).toHaveCount(0);
    await expect(accountant.getByText(/Set up your shop|Change your shop/)).toHaveCount(0);
  } finally {
    await accountant.context().close();
  }

  // Removing the accountant frees the seat and takes them off the owner's list.
  await page.goto('/app/team');
  await page.getByRole('button', { name: `Remove ${e164(accountantPhone)}` }).click();
  await expect(people.getByRole('row').filter({ hasText: e164(accountantPhone) })).toHaveCount(0);

  // The helper records trade, so the catalogue offers adding a product, but the shop and the team
  // stay the owner's.
  await invite(page, helperPhone, 'delegate');
  await expect(people.getByRole('row').filter({ hasText: e164(helperPhone) })).toContainText(
    'Helper, can record sales',
  );
  const helper = await signInMember(browser, helperPhone);
  try {
    await helper.goto('/app/catalogue');
    await expect(helper.getByText('Add a product', { exact: true })).toBeVisible();
    await expect(helper.getByText(/Set up your shop|Change your shop/)).toHaveCount(0);
    await helper.goto('/app/team');
    await expect(
      helper.getByText('Only the business owner can see and change who has access'),
    ).toBeVisible();
  } finally {
    await helper.context().close();
  }
});
