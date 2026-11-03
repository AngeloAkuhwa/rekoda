/**
 * The merchant reminder screens (REM-06), in a real browser at phone and laptop width, against
 * the real API and database (playwright.reminders.config.ts: reminders released, mail kept in
 * memory by the mock sender, no WhatsApp connection).
 *
 * The journeys: the owner sets the business phone and bank details (a bad account number is
 * refused and what they typed is kept); reminds one invoice by email and reads its history;
 * stops and resumes reminders; previews a batch with one invoice left out and why, confirms it
 * for later and cancels it. And the roles: an accountant reads everything and is offered no
 * action, and the API refuses the action anyway; a helper reads the bank details and cannot
 * change them.
 */
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import postgres from 'postgres';
import { encryptFacet } from '@rekoda/core/vault';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://rekoda@127.0.0.1:5432/rekoda_reminders';
const sql = postgres(OWNER_DATABASE_URL, { max: 2, onnotice: () => {} });
const VAULT_KEY = process.env.REKODA_E2E_VAULT_KEY!;
const API_URL = process.env.REKODA_E2E_API_URL!;
/** Set to a directory to keep full-page screenshots of each screen (visual QA). */
const SHOTS = process.env.REKODA_E2E_SHOTS;

test.afterAll(async () => {
  await sql.end();
});

/** Distinct from the other specs' ranges so runs never collide. */
const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
/* The desktop project draws from its own half of the range, so the two viewports never share a phone. */
const freshPhone = () =>
  `0816${RUN}${String(1000 + seq++ + (test.info().project.name === 'desktop' ? 500 : 0)).slice(-4)}`;

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png`, fullPage: true });
}

async function codeFor(page: Page): Promise<string> {
  const el = page.locator('[data-e2e-otp]');
  await expect(el).toHaveCount(1);
  return (await el.getAttribute('data-e2e-otp'))!;
}

/** Phone, code, business. Returns the business id, found by its unique name. */
async function onboard(page: Page): Promise<string> {
  const name = `Ada Reminders ${RUN}-${seq}-${Date.now().toString(36)}`;
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

/** An invoice issued the way a merchant does it on the dashboard: a quote, then "they said yes". */
async function invoiceFor(page: Page, naira: number, customer?: string): Promise<string> {
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

/**
 * The customer's email address, sealed with the vault key exactly as the API stores one. There
 * is no dashboard screen for adding a customer's address yet; this stands in for that record.
 */
async function giveCustomerEmail(businessId: string, invoiceNumber: string, email: string) {
  const [inv] = await sql<{ customer_id: string }[]>`
    SELECT customer_id FROM invoices
     WHERE business_id = ${businessId} AND invoice_number = ${invoiceNumber}`;
  await sql`
    INSERT INTO customer_identities (business_id, customer_id, facet, ciphertext, match_key)
    VALUES (${businessId}, ${inv!.customer_id}, 'email',
            ${encryptFacet(email, VAULT_KEY, `${businessId}:email`)}, NULL)`;
}

async function savePhone(page: Page) {
  await page.goto('/app/settings');
  await page.getByLabel('Business phone for customers').fill('0803 123 4567');
  await page.getByRole('button', { name: 'Save phone' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Every reminder from now on shows this number' }),
  ).toBeVisible();
}

/** Tomorrow at 10:00 Lagos, as the picker's value. */
function tomorrowTen(): string {
  const lagos = new Date(Date.now() + 3_600_000 + 24 * 3_600_000);
  return `${lagos.toISOString().slice(0, 10)}T10:00`;
}

async function signInMember(browser: Browser, memberPhone: string, info: TestInfo) {
  const viewport = info.project.use.viewport ?? { width: 390, height: 844 };
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('/start');
  await page.fill('#phone', memberPhone);
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/verify/);
  await page.fill('#code', await codeFor(page));
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/app/);
  return page;
}

async function invite(page: Page, memberPhone: string, role: 'accountant' | 'delegate') {
  await page.goto('/app/team');
  await page.fill('#phone', memberPhone);
  await page.selectOption('#role', role);
  await page.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added.' })).toBeVisible();
}

test('the owner sets the business phone and bank details, and a bad account number is refused', async ({
  page,
}, info) => {
  await onboard(page);
  await page.goto('/app/settings');
  await expect(page.getByRole('heading', { name: 'Payment reminders' })).toBeVisible();
  /* With no bank details and no business phone, the page must say a reminder cannot be sent yet. */
  await expect(
    page.getByText('None yet. Without them, a reminder asks customers to call your business phone'),
  ).toBeVisible();
  await expect(
    page.getByText('reminders are sent only once a business phone is saved above'),
  ).toBeVisible();
  await shot(page, info, 'settings-empty');

  await page.getByLabel('Bank', { exact: true }).fill('GTBank');
  await page.getByLabel('Account name').fill('Ada Fabrics Ltd');
  await page.getByLabel('Account number').fill('12345');
  await page.getByRole('button', { name: 'Save bank details' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'An account number is 10 digits.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Tick the box to approve' }),
  ).toBeVisible();
  // What they typed is still there to correct.
  await expect(page.getByLabel('Account number')).toHaveValue('12345');
  await expect(page.getByLabel('Account number')).toHaveAttribute('aria-invalid', 'true');
  await shot(page, info, 'settings-invalid');

  await page.getByLabel('Account number').fill('0123 456 789');
  await page.getByRole('checkbox', { name: /This is my business account/ }).check();
  await page.getByRole('button', { name: 'Save bank details' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Reminders from now on ask customers to pay' }),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Account number')).toHaveValue('0123456789');
  await expect(page.getByRole('button', { name: 'Stop showing bank details' })).toBeVisible();

  await page.getByLabel('Business phone for customers').fill('12');
  await page.getByRole('button', { name: 'Save phone' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Enter the phone number customers should call' }),
  ).toBeVisible();
  await page.getByLabel('Business phone for customers').fill('0803 123 4567');
  await page.getByRole('button', { name: 'Save phone' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Every reminder from now on shows this number' }),
  ).toBeVisible();
  await shot(page, info, 'settings-saved');

  // Save, then remove, without reloading: only the last answer may speak. Two statements about
  // where customers pay must never show together.
  await page.getByLabel('Bank', { exact: true }).fill('GTBank');
  await page.getByLabel('Account name').fill('Ada Fabrics Ltd');
  await page.getByLabel('Account number').fill('0123456789');
  await page.getByRole('checkbox', { name: /This is my business account/ }).check();
  await page.getByRole('button', { name: 'Save bank details' }).click();
  const saved = page
    .getByRole('status')
    .filter({ hasText: 'ask customers to pay into this account' });
  await expect(saved).toBeVisible();
  await page.getByRole('button', { name: 'Stop showing bank details' }).click();
  await expect(
    page.getByRole('status').filter({
      hasText: 'Removed. New reminders ask customers to call your business phone',
    }),
  ).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Removed.' })).toContainText(
    'A reminder already being sent may still show the removed account.',
  );
  await expect(saved).toHaveCount(0);
});

test('the owner reminds one invoice by email, reads its history, and stops and resumes reminders', async ({
  page,
}, info) => {
  const businessId = await onboard(page);
  const invoice = await invoiceFor(page, 45_000, 'Chiamaka Obi');
  await giveCustomerEmail(businessId, invoice, 'chiamaka@customer.example.ng');

  // Before the business phone is set, a reminder is refused, and says what to do.
  await page.goto('/app/debtors');
  await page.getByRole('link', { name: `Reminders for ${invoice}` }).click();
  await expect(page.getByRole('heading', { name: invoice, level: 1 })).toBeVisible();
  await expect(page.getByText('No reminders for this invoice yet.')).toBeVisible();
  await expect(page.getByText('₦45,000').first()).toBeVisible();
  await shot(page, info, 'invoice-empty');

  await page.getByRole('radio', { name: /^Email only/ }).check();
  await page.getByRole('button', { name: 'Send a reminder now' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Tick the box to confirm' }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: /lawful reason/ }).check();
  await page.getByRole('button', { name: 'Send a reminder now' }).click();
  const outcome = page.getByRole('status').filter({ hasText: 'Email' });
  await expect(outcome).toContainText('Not sent');
  await expect(outcome).toContainText('Add the business phone customers can call');

  await savePhone(page);
  await page.goto(`/app/reminders/invoice?number=${encodeURIComponent(invoice)}`);
  await page.getByRole('radio', { name: /^Email only/ }).check();
  await page.getByRole('checkbox', { name: /lawful reason/ }).check();
  await page.getByRole('button', { name: 'Send a reminder now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Email' })).toContainText('Sent');

  // The history keeps both, newest first, each in words.
  const history = page.getByRole('list', { name: 'Reminder history' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').first()).toContainText('Sent');
  await expect(history.getByRole('listitem').first()).toContainText('Quoted ₦45,000 as owing.');
  await expect(history.getByRole('listitem').nth(1)).toContainText('Not sent');
  await expect(page.getByText(/no_public_contact|reasonCode/)).toHaveCount(0);
  await shot(page, info, 'invoice-sent');

  // Stopping removes the send control; resuming brings it back.
  await page.getByRole('button', { name: 'Stop reminders for this invoice' }).click();
  await expect(page.getByRole('heading', { name: 'Reminders are stopped' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send a reminder now' })).toHaveCount(0);
  await shot(page, info, 'invoice-stopped');
  await page.getByRole('button', { name: 'Resume reminders' }).click();
  await expect(page.getByRole('button', { name: 'Send a reminder now' })).toBeVisible();
});

test('a batch is previewed with exclusions explained, confirmed for later, then cancelled', async ({
  page,
}, info) => {
  const businessId = await onboard(page);
  await page.goto('/app/reminders');
  await expect(page.getByText('Nobody owes you anything right now.')).toBeVisible();
  await expect(page.getByText('None yet. Pick unpaid invoices above')).toBeVisible();
  await shot(page, info, 'reminders-empty');

  const reachable = await invoiceFor(page, 30_000, 'Bayo Traders');
  await giveCustomerEmail(businessId, reachable, 'bayo@customer.example.ng');
  const anonymous = await invoiceFor(page, 12_500);
  await savePhone(page);

  await page.goto('/app/reminders');
  // Nothing picked: refused in words, nothing sent.
  await page.getByRole('button', { name: 'Preview reminders' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Pick at least one invoice' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Select all 2 invoices' }).click();
  await page.getByRole('radio', { name: /^Email only/ }).check();
  await page.getByRole('radio', { name: /^At a time you choose/ }).check();
  await page.getByLabel('Date and time to send').fill(tomorrowTen());
  await shot(page, info, 'batch-pick');
  await page.getByRole('button', { name: 'Preview reminders' }).click();

  await expect(page.getByRole('heading', { name: 'Check before you confirm' })).toBeFocused();
  await expect(page.locator('p', { hasText: 'can be reminded' })).toContainText(
    '1 invoice can be reminded by email only, on',
  );
  await expect(page.locator('p', { hasText: 'can be reminded' })).toContainText(
    '1 invoice is left out; the reason is beside each.',
  );
  /* A left-out invoice stays in the batch and is judged again at its own send: the page says so. */
  await expect(page.locator('p', { hasText: 'can be reminded' })).toContainText(
    'Left-out invoices stay in the batch. Rekoda checks each one again just before sending: one paid in the meantime is not chased, and one that can be reminded by then is reminded.',
  );
  const recipients = page.getByRole('list', { name: 'Who would be reminded' });
  await expect(recipients.getByRole('listitem').filter({ hasText: reachable })).toContainText(
    'Will be reminded',
  );
  await expect(recipients.getByRole('listitem').filter({ hasText: anonymous })).toContainText(
    'This invoice is not linked to a customer',
  );
  await expect(recipients.getByRole('listitem').filter({ hasText: anonymous })).toContainText(
    '₦12,500',
  );
  await shot(page, info, 'batch-preview');
  /* While the merchant is on the form, the previewed selection's key is held for a retry (one
   * is held for each selection passed through while picking; each is its own intention). */
  const heldBatchKeys = () =>
    page.evaluate(() =>
      Object.keys(window.sessionStorage).filter((k) => k.startsWith('rk:intent:batch:')),
    );
  expect((await heldBatchKeys()).length).toBeGreaterThan(0);

  // Confirm needs the lawful-basis box for email; the preview stays on screen.
  await page.getByRole('button', { name: 'Confirm and schedule' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Tick the box to confirm' }),
  ).toBeVisible();
  await expect(recipients).toBeVisible();
  await page.getByRole('checkbox', { name: /lawful reason/ }).check();
  const heldBefore = (await heldBatchKeys()).length;
  await page.getByRole('button', { name: 'Confirm and schedule' }).click();

  /* The Confirm redirect lands with new=1, which the page spends and removes from the address. */
  await expect(page).toHaveURL(/\/app\/reminders\/[0-9a-f-]{36}$/);
  const firstBatchUrl = page.url();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('2 invoices, scheduled');
  /* The batch exists: its selection's key is released, and only that one, so the same
   * selection later is a new batch while other held selections keep theirs. */
  await expect.poll(async () => (await heldBatchKeys()).length).toBe(heldBefore - 1);
  const items = page.getByRole('list', { name: 'Recipients' });
  await expect(items.getByRole('listitem')).toHaveCount(2);
  await expect(items.getByRole('listitem').filter({ hasText: reachable })).toContainText(
    'Waiting to send',
  );
  await shot(page, info, 'batch-scheduled');

  // Cancel asks first, in the merchant's terms, then stops what has not gone.
  await page.getByRole('button', { name: 'Cancel the reminders not sent yet' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'does not take it back' })).toBeVisible();
  // Asking cancelled nothing: the first press only asks.
  await page.getByRole('button', { name: 'Keep them' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('2 invoices, scheduled');
  await page.getByRole('button', { name: 'Cancel the reminders not sent yet' }).click();
  await page.getByRole('button', { name: 'Yes, cancel them' }).click();
  await expect(page.getByRole('status')).toContainText(
    'Cancelled. 2 invoices will not be reminded.',
  );
  /* The Confirm marker stays spent through the cancel's refresh: the address must not regain
   * new=1, or going Back here later would release another Confirm's held key. */
  await expect(page).not.toHaveURL(/new=1/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('2 invoices, cancelled');
  await expect(items.getByRole('listitem').first()).toContainText('Cancelled');
  await expect(page.getByRole('button', { name: 'Cancel the reminders not sent yet' })).toHaveCount(
    0,
  );
  await shot(page, info, 'batch-cancelled');

  await page.goto('/app/reminders');
  await expect(page.getByRole('list', { name: 'Reminder batches' })).toContainText('Cancelled');

  /* The same selection again, minutes later, is a new batch: never a replay of the cancelled one. */
  await page.getByRole('button', { name: 'Select all 2 invoices' }).click();
  await page.getByRole('radio', { name: /^Email only/ }).check();
  await page.getByRole('radio', { name: /^At a time you choose/ }).check();
  await page.getByLabel('Date and time to send').fill(tomorrowTen());
  await page.getByRole('button', { name: 'Preview reminders' }).click();
  await page.getByRole('checkbox', { name: /lawful reason/ }).check();
  await page.getByRole('button', { name: 'Confirm and schedule' }).click();
  await expect(page).toHaveURL(/\/app\/reminders\/[0-9a-f-]{36}$/);
  expect(page.url()).not.toBe(firstBatchUrl);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('2 invoices, scheduled');
});

test('an accountant reads reminders but is offered no action and is refused one; a helper cannot change bank details', async ({
  page,
  browser,
}, info) => {
  const businessId = await onboard(page);
  const invoice = await invoiceFor(page, 20_000, 'Ngozi Stores');
  await giveCustomerEmail(businessId, invoice, 'ngozi@customer.example.ng');
  await savePhone(page);
  await page.goto('/app/settings');
  await page.getByLabel('Bank', { exact: true }).fill('Access Bank');
  await page.getByLabel('Account name').fill('Ada Fabrics Ltd');
  await page.getByLabel('Account number').fill('0987654321');
  await page.getByRole('checkbox', { name: /This is my business account/ }).check();
  await page.getByRole('button', { name: 'Save bank details' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();

  // A scheduled batch for the accountant to look at.
  await page.goto('/app/reminders');
  await page.getByRole('checkbox', { name: new RegExp(invoice) }).check();
  await page.getByRole('radio', { name: /^WhatsApp only/ }).check();
  await page.getByRole('radio', { name: /^At a time you choose/ }).check();
  await page.getByLabel('Date and time to send').fill(tomorrowTen());
  await page.getByRole('button', { name: 'Preview reminders' }).click();
  await expect(page.getByRole('heading', { name: 'Check before you confirm' })).toBeVisible();
  // The customer has no WhatsApp number on file: left out, in words, and nothing to confirm.
  await expect(
    page.getByText('You do not have a WhatsApp number for this customer.'),
  ).toBeVisible();
  await expect(page.getByText('None of these can be reminded right now.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirm and/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Change the selection' }).click();
  await page.getByRole('radio', { name: /^Email only/ }).check();
  await page.getByRole('button', { name: 'Preview reminders' }).click();
  await page.getByRole('checkbox', { name: /lawful reason/ }).check();
  await page.getByRole('button', { name: 'Confirm and schedule' }).click();
  await expect(page).toHaveURL(/\/app\/reminders\/[0-9a-f-]{36}$/);
  const batchUrl = page.url();
  const batchId = batchUrl.split('/').pop()!;

  const accountantPhone = freshPhone();
  await invite(page, accountantPhone, 'accountant');
  const accountant = await signInMember(browser, accountantPhone, info);
  try {
    await accountant.goto('/app/reminders');
    await expect(accountant.getByText('Your access is view only')).toBeVisible();
    await expect(accountant.getByRole('button', { name: 'Preview reminders' })).toHaveCount(0);
    await expect(accountant.getByRole('list', { name: 'Reminder batches' })).toContainText(
      'Scheduled',
    );
    await shot(accountant, info, 'accountant-reminders');

    await accountant.goto(batchUrl);
    await expect(accountant.getByRole('heading', { level: 1 })).toHaveText('1 invoice, scheduled');
    await expect(
      accountant.getByRole('button', { name: 'Cancel the reminders not sent yet' }),
    ).toHaveCount(0);

    await accountant.goto(`/app/reminders/invoice?number=${encodeURIComponent(invoice)}`);
    await expect(
      accountant.getByRole('heading', { name: 'Reminders for this invoice' }),
    ).toBeVisible();
    await expect(accountant.getByRole('button', { name: 'Send a reminder now' })).toHaveCount(0);
    await expect(accountant.getByRole('button', { name: /Stop reminders|Resume/ })).toHaveCount(0);

    await accountant.goto('/app/settings');
    await expect(
      accountant.getByText('Only the owner can set the business phone and bank details'),
    ).toBeVisible();
    await expect(accountant.getByText('0987654321')).toHaveCount(0);

    // The screen hides the action; the API refuses it whatever the screen does.
    const session = (await accountant.context().cookies()).find((c) => c.name === 'rk_session');
    const refused = await accountant.request.post(
      `${API_URL}/v1/reminders/batches/${batchId}/cancel`,
      { headers: { authorization: `Bearer ${session!.value}` } },
    );
    expect(refused.status()).toBe(403);
  } finally {
    await accountant.context().close();
  }

  // The batch is untouched by the refused cancel.
  await page.goto(batchUrl);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('1 invoice, scheduled');

  // Seat limits are the plan's business, not this test's: the accountant is removed first so the
  // helper's invitation is about roles, not seats.
  await page.goto('/app/team');
  const e164 = `+234${accountantPhone.slice(1)}`;
  await page.getByRole('button', { name: `Remove ${e164}` }).click();
  const helperPhone = freshPhone();
  await invite(page, helperPhone, 'delegate');
  const helper = await signInMember(browser, helperPhone, info);
  try {
    await helper.goto('/app/settings');
    await expect(helper.getByText('0987654321')).toBeVisible();
    await expect(helper.getByText('Only the owner can change the bank details')).toBeVisible();
    await expect(helper.getByRole('button', { name: 'Save bank details' })).toHaveCount(0);
    await expect(helper.getByRole('button', { name: 'Save phone' })).toHaveCount(0);
    await shot(helper, info, 'helper-settings');

    const session = (await helper.context().cookies()).find((c) => c.name === 'rk_session');
    const refused = await helper.request.put(`${API_URL}/v1/reminders/payment-instruction`, {
      headers: { authorization: `Bearer ${session!.value}` },
      data: {
        bankName: 'Other Bank',
        accountName: 'Somebody Else',
        accountNumber: '1111111111',
        approve: true,
      },
    });
    expect(refused.status()).toBe(403);

    // A helper does day-to-day trade: the reminder actions are theirs.
    await helper.goto('/app/reminders');
    await expect(helper.getByRole('button', { name: 'Preview reminders' })).toBeVisible();
    await helper.goto(batchUrl);
    await expect(
      helper.getByRole('button', { name: 'Cancel the reminders not sent yet' }),
    ).toBeVisible();
  } finally {
    await helper.context().close();
  }
});
