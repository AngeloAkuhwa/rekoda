/**
 * The complete first purchase, in a real browser: a new merchant picks a plan, pays on a
 * (stand-in) Paystack page, is sent back to Rekoda, sees the plan switch on, and a replayed
 * webhook changes nothing; then managing the plan, and a cancellation taken back and one left to
 * run. Billing journeys 1 to 13 of the owner's list, against Rekoda's real
 * API, worker and database; only Paystack itself is a stand-in (e2e/support/fake-paystack.mjs).
 * The real Paystack test-mode run is a staging acceptance step, not claimed here.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import postgres from 'postgres';

const OWNER_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rekoda@127.0.0.1:5432/rekoda';
const sql = postgres(OWNER_DATABASE_URL, { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const PAYSTACK_SECRET = process.env.REKODA_E2E_PAYSTACK_SECRET!;
const FAKE_PAYSTACK = process.env.REKODA_E2E_FAKE_PAYSTACK_URL!;
const API = process.env.REKODA_E2E_API_URL!;

const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
/**
 * A phone number no other run of this file has used. RUN is random per worker process, so two
 * projects (mobile, desktop) running the same file could draw the same RUN once in 900 times and
 * collide on a number that is already a merchant. The desktop project therefore takes a
 * different block of numbers.
 */
const freshPhone = () =>
  `0818${RUN}${String(1000 + seq++ + (test.info().project.name === 'desktop' ? 500 : 0)).slice(-4)}`;

async function onboard(page: Page, name: string): Promise<string> {
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
  const [row] = await sql<{ id: string }[]>`SELECT id FROM businesses WHERE name = ${name}`;
  return row!.id;
}

/** What Paystack does after a customer pays: mark it paid, then send the signed webhook. */
async function customerPays(request: APIRequestContext, reference: string, eventId: number) {
  const paid = await request.post(`${FAKE_PAYSTACK}/__pay/${reference}`);
  const { amount } = (await paid.json()) as { amount: number };
  const raw = JSON.stringify({
    event: 'charge.success',
    data: {
      id: eventId,
      reference,
      amount,
      currency: 'NGN',
      status: 'success',
      customer: { email: 'ada@shop.example.ng' },
    },
  });
  const signature = createHmac('sha512', PAYSTACK_SECRET).update(raw, 'utf8').digest('hex');
  const response = await request.post(`${API}/webhooks/paystack`, {
    data: raw,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
  });
  expect(response.status()).toBe(200);
}

test('a new merchant pays for a plan on Paystack, comes back, and the plan switches on once', async ({
  page,
  request,
}) => {
  const name = `Ada Journey ${RUN}-${seq}`;
  const businessId = await onboard(page, name);

  // Plan choice, with the price shown before anything is committed.
  await page.goto('/app/billing');
  await page
    .getByRole('row', { name: /Rekoda Chat/ })
    .getByRole('link')
    .click();
  await expect(page.getByText('₦9,900 today', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and pay' }).click();

  // A payment is now waiting; the receipt address is asked for once.
  await page.fill('#payBillingEmail', 'ada@shop.example.ng');
  await page.getByRole('button', { name: 'Pay with Paystack' }).click();

  // Paystack's hosted page opens, and knows where to send the merchant back to.
  await expect(page.getByRole('heading', { name: 'Fake Paystack checkout' })).toBeVisible();
  const reference = (await page.locator('[data-ref]').textContent())!.trim();
  await expect(page.getByRole('link', { name: 'Return to merchant' })).toHaveAttribute(
    'href',
    /\/app\/billing\/return\?trxref=/,
  );

  // The payment record of a payment that has only been started says so: not paid, not applied.
  const pending = await page.context().newPage();
  await pending.goto(`/app/billing/payments/${reference}`);
  await expect(pending.getByRole('heading', { name: 'Not paid yet' })).toBeVisible();
  await expect(pending.getByText('Not confirmed')).toBeVisible();
  await expect(pending.getByText('Confirmed by Paystack')).toHaveCount(0);
  await expect(pending.locator('dt', { hasText: 'Applied to your account' })).toBeVisible();
  await expect(pending.locator('dd', { hasText: /^No$/ })).toBeVisible();
  await pending.close();

  // Before anything is confirmed, coming back must NOT claim a plan.
  await page.getByRole('link', { name: 'Return to merchant' }).click();
  await expect(page.getByRole('heading', { name: 'Payment status' })).toBeVisible();
  await expect(page.locator('[data-return=confirming]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Payment received' })).toHaveCount(0);

  const eventId = Date.now();
  await customerPays(request, reference, eventId);

  // The page asks again by itself and the verified payment turns it to paid.
  await expect(page.getByRole('heading', { name: 'Payment received' })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText(/Your Chat plan is active until/)).toBeVisible();

  // The billing page agrees: the plan, and the payment in the history as paid.
  await page.getByRole('link', { name: 'Back to billing' }).click();
  await expect(page.getByText('Rekoda Chat').first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Paid' }).first()).toBeVisible();

  // The history links to the payment record: verified status, reference, amount, what it bought,
  // the period, that it was applied, and a neutral note that it is not a tax document.
  await page.getByRole('link', { name: reference }).click();
  await expect(page.getByRole('heading', { name: 'Payment record' })).toBeVisible();
  await expect(page.locator('[data-state=paid_applied]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paid', exact: true })).toBeVisible();
  await expect(page.getByText('Confirmed by Paystack')).toBeVisible();
  await expect(page.getByText(reference, { exact: true })).toBeVisible();
  await expect(page.getByText(/₦9,900/).first()).toBeVisible();
  await expect(page.getByText(/Subscription · Rekoda Chat/)).toBeVisible();
  await expect(page.locator('dt', { hasText: 'Service period' })).toBeVisible();
  await expect(page.locator('dt', { hasText: 'Payment recorded on' })).toBeVisible();
  await expect(page.locator('dd', { hasText: /^Yes$/ })).toBeVisible();
  await expect(page.getByText(/not a VAT invoice, tax invoice or tax receipt/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
  // No horizontal scroll at the mobile width this file runs at.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.goBack();

  // The worker has applied the one event. A redelivery of it is dropped at the door and changes
  // nothing: the same single event row, the same paid-to date, still one paid charge.
  const eventKey = `${eventId}:charge.success`;
  const state = async () => {
    const [row] = await sql<{ events: number; processed: number; ends: string; paid: number }[]>`
      SELECT (SELECT count(*)::int FROM external_events WHERE external_id = ${eventKey}) AS events,
             (SELECT count(*)::int FROM external_events
               WHERE external_id = ${eventKey} AND processed_at IS NOT NULL) AS processed,
             (SELECT plan_expires_at::text FROM businesses WHERE id = ${businessId}) AS ends,
             (SELECT count(*)::int FROM subscription_charges
               WHERE business_id = ${businessId} AND status = 'paid') AS paid`;
    return row!;
  };
  await expect.poll(async () => (await state()).processed, { timeout: 20_000 }).toBe(1);
  const before = await state();
  expect(before).toMatchObject({ events: 1, paid: 1 });

  await customerPays(request, reference, eventId);
  // Give a (wrong) second application time to show, then compare with the state before.
  await page.waitForTimeout(2_000);
  expect(await state()).toEqual(before);
});

/**
 * From a payment that is waiting (the "Pay with Paystack" button is showing): open Paystack, have
 * the customer pay, deliver the signed webhook, come back, and wait for the verified result.
 */
async function payWaiting(page: Page, request: APIRequestContext): Promise<string> {
  const button = page.getByRole('button', { name: 'Pay with Paystack' });
  await expect(button).toBeVisible();
  if (await page.locator('#payBillingEmail').count()) {
    await page.fill('#payBillingEmail', 'ada@shop.example.ng');
  }
  await button.click();
  const reference = (await page.locator('[data-ref]').textContent())!.trim();
  await customerPays(request, reference, Date.now() + seq++);
  await page.getByRole('link', { name: 'Return to merchant' }).click();
  await expect(page.getByRole('heading', { name: 'Payment received' })).toBeVisible({
    timeout: 45_000,
  });
  return reference;
}

test('a paying merchant upgrades, schedules a downgrade and a yearly switch, buys a pack and cancels', async ({
  page,
  request,
}) => {
  await onboard(page, `Ada Manage ${RUN}-${seq}`);

  // First purchase: Chat.
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const chatPayment = await payWaiting(page, request);

  // Upgrade to Integrate: the pro-rated difference is shown, paid, and the plan changes at once.
  await page.goto('/app/billing?to=integrate');
  await expect(page.getByText(/₦1\d,\d{3} today|₦9,\d{3} today|₦10,\d{3} today/)).toBeVisible();
  await page.getByRole('button', { name: /Confirm/ }).click();
  const upgradePayment = await payWaiting(page, request);
  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Integrate');

  // Downgrade to Chat: nothing is charged, it is scheduled for the next renewal and can be undone.
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: /Confirm/ }).click();
  await expect(
    page.getByText(
      'Changing to Rekoda Chat at your next renewal. You keep what you paid for until then.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stay on Rekoda Integrate' })).toBeVisible();

  // Switch to yearly billing at the next renewal, also undoable.
  await page.getByRole('button', { name: 'Switch to yearly at my next renewal' }).click();
  await expect(
    page.getByText(
      'Switching to yearly billing at your next renewal. You keep your current monthly plan until then, and nothing is charged now.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stay on monthly billing' })).toBeVisible();

  // A usage pack is paid for like a plan and raises the meter by exactly its size.
  await page
    .getByRole('row', { name: /50 extra document generations/ })
    .getByRole('button', { name: 'Buy' })
    .click();
  const packPayment = await payWaiting(page, request);
  await expect(
    page.getByText('Your 50 extra document generations pack has been added to your account.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to billing' }).click();
  await expect(page.getByText(/\(50 bought\)/).first()).toBeVisible();

  // The upgrade's record says it covers the rest of the period, never a whole month.
  await page.goto(`/app/billing/payments/${upgradePayment}`);
  await expect(page.getByText(/Plan upgrade · Rekoda Integrate/)).toBeVisible();
  await expect(page.getByText(/for the rest of your current billing period/)).toBeVisible();
  await expect(page.getByText(/month of service/)).toHaveCount(0);
  await page.goto('/app/billing');

  // Every payment is in the history as paid.
  for (const reference of [chatPayment, upgradePayment, packPayment]) {
    await expect(
      page.getByRole('row').filter({ hasText: reference }).getByRole('cell', { name: 'Paid' }),
    ).toBeVisible();
  }

  // Cancelling keeps the access already paid for, and can be taken back.
  await page.locator('summary', { hasText: 'Cancel my subscription' }).click();
  await page.getByRole('button', { name: 'Cancel my subscription' }).click();
  await expect(page.getByRole('button', { name: 'Keep my subscription' })).toBeVisible();
});

test('a cancelled plan can be kept before it ends, and a cancellation left to run stops the plan with no charge', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Cancels ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const paid = await payWaiting(page, request);
  await page.goto('/app/billing');
  const renews = page.getByText(/^Renews on .+\.$/);
  const renewsBefore = (await renews.textContent())!;
  const pendingOf = async () => {
    const [state] = await sql<{ pending: string | null }[]>`
      SELECT pending_plan AS pending FROM businesses WHERE id = ${businessId}::uuid`;
    return state!.pending;
  };

  // Cancelling stops the next charge and keeps the month already paid for.
  const cancel = async () => {
    await page.locator('summary', { hasText: 'Cancel my subscription' }).click();
    await page.getByRole('button', { name: 'Cancel my subscription' }).click();
    await expect(page.getByRole('button', { name: 'Keep my subscription' })).toBeVisible();
  };
  await cancel();
  await expect(
    page.getByText(
      'Cancelled: your plan runs to the end of what you paid for, then stops without charging.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');
  expect(await pendingOf()).toBe('expired');

  // Keeping it takes the cancellation back: same plan, same renewal date, nothing scheduled.
  await page.getByRole('button', { name: 'Keep my subscription' }).click();
  await expect(
    page.getByText(
      'Done. Your plan carries on as it is, and the change you scheduled is cancelled.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText(/^Cancelled: your plan runs to/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep my subscription' })).toHaveCount(0);
  await expect(renews).toHaveText(renewsBefore);
  expect(await pendingOf()).toBeNull();

  // Cancelled again and left to run: the paid month ends and the renewal sweep stops the plan.
  // The plan columns are written here as `expireSubscription(…, 'cancelled')` sets them (its
  // audit row is left out: nothing here reads it), because the hourly sweep and the clock are not
  // what is under test; billing.integration.test.ts runs the sweep's cancelled branch.
  await cancel();
  expect(await pendingOf()).toBe('expired');
  await sql.begin(async (tx) => {
    await tx`UPDATE subscription_charges
             SET period_start = period_start - interval '32 days',
                 period_end = period_end - interval '32 days',
                 applied_period_start = applied_period_start - interval '32 days',
                 applied_period_end = applied_period_end - interval '32 days',
                 created_at = created_at - interval '32 days',
                 paid_at = paid_at - interval '32 days'
             WHERE business_id = ${businessId}::uuid`;
    await tx`UPDATE businesses
             SET plan = 'expired', pending_plan = NULL, plan_decided_at = clock_timestamp(),
                 plan_expires_at = plan_expires_at - interval '32 days',
                 cycle_started_at = cycle_started_at - interval '32 days'
             WHERE id = ${businessId}::uuid AND pending_plan = 'expired'`;
  });

  const [ended] = await sql<{ ends: Date }[]>`
    SELECT plan_expires_at AS ends FROM businesses WHERE id = ${businessId}::uuid`;
  await page.goto('/app/billing');
  await expect(page.getByText(/Your subscription stopped on/)).toBeVisible();
  // It stopped on the last day paid for, not on the day the page was read.
  await expect(
    page.getByText(
      `Stopped ${ended!.ends.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric' })}.`,
      { exact: true },
    ),
  ).toBeVisible();
  // A cancellation is not a missed payment: the page offers no grace period and no renewal to
  // pay, and nothing on the way here (cancel, keep, cancel) raised a charge.
  await expect(page.getByText(/renewal is due/)).toHaveCount(0);
  await expect(page.getByText(/Grace period ends/)).toHaveCount(0);
  await expect(page.locator('#pay')).toHaveCount(0);
  const [facts] = await sql<{ charges: number }[]>`
    SELECT count(*)::int AS charges FROM subscription_charges WHERE business_id = ${businessId}::uuid`;
  expect(facts).toEqual({ charges: 1 });
  await expect(
    page.getByRole('row').filter({ hasText: paid }).getByRole('cell', { name: 'Paid' }),
  ).toBeVisible();
});

test('coming back to the payment page with a reference that is not yours shows nothing', async ({
  page,
}) => {
  await onboard(page, `Ada Stranger ${RUN}-${seq}`);
  await page.goto('/app/billing/return?reference=RKD-SUB-20260101-ZZZZZZ');
  await expect(page.getByRole('heading', { name: 'We could not find that payment' })).toBeVisible();
  await page.goto('/app/billing/return?reference=%3Cscript%3E');
  await expect(page.getByRole('heading', { name: 'We could not find that payment' })).toBeVisible();
});

test("another merchant's payment record, and one that does not exist, show nothing", async ({
  page,
  browser,
  request,
}) => {
  // Merchant A has a real payment waiting.
  const businessId = await onboard(page, `Ada Owner ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  await expect(page.getByRole('button', { name: 'Pay with Paystack' })).toBeVisible();
  const [charge] = await sql<{ reference: string }[]>`
    SELECT reference FROM subscription_charges WHERE business_id = ${businessId}`;
  const reference = charge!.reference;
  await page.goto(`/app/billing/payments/${reference}`);
  await expect(page.getByRole('heading', { name: 'Not paid yet' })).toBeVisible();

  // Merchant B, in a separate session, cannot read it, and cannot tell it from a missing one.
  const other = await (await browser.newContext()).newPage();
  await onboard(other, `Bola Stranger ${RUN}-${seq}`);
  await other.goto(`/app/billing/payments/${reference}`);
  await expect(other.getByRole('heading', { name: 'That page does not exist' })).toBeVisible();
  await expect(other.getByText(reference)).toHaveCount(0);
  await expect(other.getByRole('heading', { name: 'Payment record' })).toHaveCount(0);
  await expect(other.getByText('Not paid yet')).toHaveCount(0);
  await other.goto('/app/billing/payments/RKD-SUB-20260101-ZZZZZZ');
  await expect(other.getByRole('heading', { name: 'That page does not exist' })).toBeVisible();
  void request;
});
