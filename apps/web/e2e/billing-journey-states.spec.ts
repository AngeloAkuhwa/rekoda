/**
 * The billing page in the states between "just paid" and "lapsed", in a real browser.
 *
 * Complements billing-journey.spec.ts (the first purchase and plan management) and
 * billing-journey-lifecycle.spec.ts (declines, late payments, refunds, a lapse): a renewal that is
 * overdue and waiting to be paid, the same renewal paid (monthly and yearly), a yearly subscriber,
 * a checkout recovered after the merchant lost the Paystack link, and the same page as an
 * accountant sees it. Same stack: Rekoda's real API,
 * worker and database, with Paystack itself a stand-in (e2e/support/fake-paystack.mjs). An overdue
 * renewal is put in the database directly, as the renewal sweep would write it, because the clock
 * and the sweep are not what is under test here; billing-renewal.integration.test.ts covers the sweep.
 * Real Paystack test mode is a staging step, not claimed here.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
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
 * A block of numbers apart from the other journey specs (0818..., 0819...) and every other spec,
 * and one per project. `prefix` keeps an owner and the accountant they invite apart.
 */
const freshPhone = (prefix = '0806') =>
  `${prefix}${RUN}${String(1000 + seq++ + (test.info().project.name === 'desktop' ? 500 : 0)).slice(-4)}`;

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
async function customerPays(request: APIRequestContext, reference: string) {
  const paid = await request.post(`${FAKE_PAYSTACK}/__pay/${reference}`);
  const { amount } = (await paid.json()) as { amount: number };
  const raw = JSON.stringify({
    event: 'charge.success',
    data: {
      id: Date.now() + seq++,
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

/** From a confirmed plan choice: open Paystack's page and return the reference being paid. */
async function openPaystack(page: Page): Promise<string> {
  /* Wait for the new payment's own address: an older waiting payment shows its own Pay button too. */
  await page.waitForURL(/[?&]pay=/);
  const button = page.getByRole('button', { name: 'Pay with Paystack' });
  await expect(button).toBeVisible();
  if (await page.locator('#payBillingEmail').count()) {
    await page.fill('#payBillingEmail', 'ada@shop.example.ng');
  }
  await button.click();
  await expect(page.getByRole('heading', { name: 'Fake Paystack checkout' })).toBeVisible();
  return (await page.locator('[data-ref]').textContent())!.trim();
}

async function payAndReturn(page: Page, request: APIRequestContext, reference: string) {
  await customerPays(request, reference);
  await page.getByRole('link', { name: 'Return to merchant' }).click();
  await expect(page.getByRole('heading', { name: 'Payment received' })).toBeVisible({
    timeout: 45_000,
  });
}

/** A subscription reference in Rekoda's own shape (`RKD-SUB-YYYYMMDD-XXXXXX`, Crockford alphabet). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const mintReference = () =>
  `RKD-SUB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${[...randomBytes(6)]
    .map((byte) => ALPHABET[byte % 32])
    .join('')}`;

/** The date the billing page writes, in Lagos, computed the same way. */
const lagosDate = (at: Date) =>
  at.toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * The paid cycle ended two days ago and the renewal sweep raised the next cycle's charge, starting
 * the grace clock at the renewal date. Written as the sweep writes it, in one transaction so the
 * in-process sweep never sees a due cycle without its charge. Returns the renewal's reference.
 */
async function renewalOverdue(
  businessId: string,
  paid: string,
  interval: 'monthly' | 'annual' = 'monthly',
): Promise<string> {
  const cycle = interval === 'annual' ? '1 year' : '1 month';
  const amountK = interval === 'annual' ? 9_900_000 : 990_000;
  const renewal = mintReference();
  await sql.begin(async (tx) => {
    await tx`UPDATE subscription_charges
             SET period_start = now() - (${cycle}::interval + interval '2 days'),
                 period_end = now() - interval '2 days',
                 applied_period_start = now() - (${cycle}::interval + interval '2 days'),
                 applied_period_end = now() - interval '2 days',
                 created_at = created_at - (${cycle}::interval + interval '2 days'),
                 paid_at = paid_at - (${cycle}::interval + interval '2 days')
             WHERE reference = ${paid}`;
    await tx`INSERT INTO subscription_charges
               (business_id, kind, plan, quantity, amount_k, provider, reference,
                period_start, period_end, billing_interval, created_at)
             VALUES (${businessId}::uuid, 'renewal', 'chat', 1, ${amountK}, 'paystack', ${renewal},
                     now() - interval '2 days', now() - interval '2 days' + ${cycle}::interval,
                     ${interval}, now() - interval '2 days')`;
    await tx`UPDATE businesses
             SET plan_expires_at = now() - interval '2 days',
                 payment_failed_at = now() - interval '2 days',
                 cycle_started_at = cycle_started_at - (${cycle}::interval + interval '2 days'),
                 plan_decided_at = plan_decided_at - (${cycle}::interval + interval '2 days')
             WHERE id = ${businessId}::uuid`;
  });
  return renewal;
}

/** Pay the renewal the billing page is asking for, from its pay card. */
async function payRenewal(page: Page, request: APIRequestContext) {
  await page.goto('/app/billing');
  const pay = page.locator('#pay');
  await expect(pay.getByRole('heading', { name: 'Pay for your plan' })).toBeVisible();
  if (await pay.locator('#payBillingEmail').count()) {
    await pay.locator('#payBillingEmail').fill('ada@shop.example.ng');
  }
  await pay.getByRole('button', { name: 'Pay with Paystack' }).click();
  await expect(page.getByRole('heading', { name: 'Fake Paystack checkout' })).toBeVisible();
  const attempt = (await page.locator('[data-ref]').textContent())!.trim();
  await payAndReturn(page, request, attempt);
}

/** The subscription columns a paid renewal must restore. */
const subscriptionOf = async (businessId: string) => {
  const [state] = await sql<{ ends: Date; failed: Date | null; plan: string; interval: string }[]>`
    SELECT plan_expires_at AS ends, payment_failed_at AS failed, plan, billing_interval AS interval
    FROM businesses WHERE id = ${businessId}::uuid`;
  return state!;
};

const row = (page: Page, reference: string) => page.getByRole('row').filter({ hasText: reference });
const historyRows = (page: Page) =>
  page
    .locator('.rk-card')
    .filter({ has: page.getByRole('heading', { name: 'Billing history' }) })
    .locator('tbody tr');
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

test('a renewal that is due and not yet paid shows the grace period and asks for the payment, never calling it failed', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Grace ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const first = await openPaystack(page);
  await payAndReturn(page, request, first);

  const renewal = await renewalOverdue(businessId, first);
  const [clock] = await sql<{ failed: Date }[]>`
    SELECT payment_failed_at AS failed FROM businesses WHERE id = ${businessId}::uuid`;
  // Seven days of grace from the renewal date: five of them are left.
  const graceEnds = lagosDate(new Date(clock!.failed.getTime() + 7 * 86_400_000));

  await page.goto('/app/billing');

  // The strip says the renewal is due and unpaid, with the date it runs to and the days left.
  await expect(page.locator('.rk-attention-strip')).toHaveText(
    `Your plan's renewal is due and we have not received the payment yet. Everything keeps working until ${graceEnds}, 5 days from now. Your records are safe. Message upgrade on WhatsApp and we will sort it out with you.`,
  );
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');
  await expect(page.getByText(`Grace period ends ${graceEnds}.`, { exact: true })).toBeVisible();

  // The renewal waits to be paid: the pay card offers Paystack and a lost-link recovery, and tells
  // a merchant who has already paid not to pay again.
  const pay = page.locator('#pay');
  await expect(pay.getByRole('heading', { name: 'Pay for your plan' })).toBeVisible();
  await expect(pay).toContainText('₦9,900 for renewal · Rekoda Chat');
  await expect(pay).toContainText(renewal);
  await expect(pay.getByRole('button', { name: 'Pay with Paystack' })).toBeVisible();
  await expect(pay.getByRole('button', { name: 'I lost my payment link' })).toBeVisible();
  await expect(
    pay.getByText(
      'Already paid? It can take a minute to show here. Refresh this page, and do not pay again.',
    ),
  ).toBeVisible();

  // The history lists the renewal as awaiting payment, beside the month already paid.
  await expect(row(page, renewal)).toContainText('Renewal · Rekoda Chat');
  await expect(row(page, renewal).getByRole('cell', { name: 'Awaiting payment' })).toBeVisible();
  await expect(row(page, first).getByRole('cell', { name: 'Paid' })).toBeVisible();

  // Nothing was attempted at Paystack, so nothing on the page says a payment failed.
  await expect(page.getByText(/did not go through/)).toHaveCount(0);
  await noHorizontalScroll(page);
});

test('a yearly subscriber sees the price a year, a renewal a year out, and the offer to go monthly', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Yearly ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat&interval=annual');
  await expect(
    page.getByText('₦99,000 today for twelve months of service', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const reference = await openPaystack(page);
  await payAndReturn(page, request, reference);

  const [state] = await sql<{ ends: Date; interval: string }[]>`
    SELECT plan_expires_at AS ends, billing_interval AS interval
    FROM businesses WHERE id = ${businessId}::uuid`;
  expect(state!.interval).toBe('annual');
  // Twelve months of service, not one: the paid-to date is a year out.
  const daysAhead = (state!.ends.getTime() - Date.now()) / 86_400_000;
  expect(daysAhead).toBeGreaterThan(360);
  expect(daysAhead).toBeLessThan(370);

  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toHaveText('Rekoda Chat · ₦99,000 a year');
  await expect(
    page.getByText(`Renews on ${lagosDate(state!.ends)}.`, { exact: true }),
  ).toBeVisible();

  // The history names the yearly purchase as yearly.
  await expect(row(page, reference)).toContainText('Subscription · Rekoda Chat · Yearly');
  await expect(row(page, reference).getByRole('cell', { name: 'Paid' })).toBeVisible();

  // The frequency card says how they pay and offers monthly from the next renewal.
  await expect(page.getByRole('heading', { name: 'Billing frequency' })).toBeVisible();
  await expect(page.getByText('You pay once a year.', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'Go back to paying month by month. It starts at your next renewal, after the year you paid for.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Switch to monthly at my next renewal' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Switch to yearly at my next renewal' }),
  ).toHaveCount(0);
  await noHorizontalScroll(page);
});

test('a merchant in grace pays the renewal from the billing page, and the plan runs a month from the renewal date', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Renews ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const first = await openPaystack(page);
  await payAndReturn(page, request, first);
  const renewal = await renewalOverdue(businessId, first);
  const [due] = await sql<{ end: Date }[]>`
    SELECT period_end AS end FROM subscription_charges WHERE reference = ${renewal}`;

  await payRenewal(page, request);

  // The renewal buys the month it was raised for, from the renewal date, not from today: paying
  // two days late does not move the anchor, and it gives no extra days either.
  const after = await subscriptionOf(businessId);
  expect(after).toMatchObject({ plan: 'chat', failed: null, interval: 'monthly' });
  expect(after.ends.getTime()).toBe(due!.end.getTime());

  await page.goto('/app/billing');
  await expect(page.getByText(/renewal is due/)).toHaveCount(0);
  await expect(page.getByText(/Grace period ends/)).toHaveCount(0);
  await expect(page.getByText(`Renews on ${lagosDate(after.ends)}.`, { exact: true })).toBeVisible();
  await expect(page.locator('#pay')).toHaveCount(0);
  await expect(row(page, renewal)).toContainText('Renewal · Rekoda Chat');
  await expect(row(page, renewal).getByRole('cell', { name: 'Paid' })).toBeVisible();
  await expect(row(page, first).getByRole('cell', { name: 'Paid' })).toBeVisible();
  await expect(historyRows(page)).toHaveCount(2);
  await noHorizontalScroll(page);
});

test('a yearly subscriber whose year has ended pays the yearly renewal, and the plan runs another year', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Renews Yearly ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat&interval=annual');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const first = await openPaystack(page);
  await payAndReturn(page, request, first);
  const renewal = await renewalOverdue(businessId, first, 'annual');
  const [due] = await sql<{ end: Date }[]>`
    SELECT period_end AS end FROM subscription_charges WHERE reference = ${renewal}`;

  // The pay card asks for a year at the yearly price, never a month.
  await page.goto('/app/billing');
  await expect(page.locator('#pay')).toContainText('₦99,000 for renewal · Rekoda Chat');
  await payRenewal(page, request);

  const after = await subscriptionOf(businessId);
  expect(after).toMatchObject({ plan: 'chat', failed: null, interval: 'annual' });
  expect(after.ends.getTime()).toBe(due!.end.getTime());
  const daysAhead = (after.ends.getTime() - Date.now()) / 86_400_000;
  expect(daysAhead).toBeGreaterThan(360);
  expect(daysAhead).toBeLessThan(366);

  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toHaveText('Rekoda Chat · ₦99,000 a year');
  await expect(page.getByText(/renewal is due/)).toHaveCount(0);
  await expect(page.getByText(`Renews on ${lagosDate(after.ends)}.`, { exact: true })).toBeVisible();
  await expect(row(page, renewal)).toContainText('Renewal · Rekoda Chat · Yearly');
  await expect(row(page, renewal).getByRole('cell', { name: 'Paid' })).toBeVisible();
  await expect(historyRows(page)).toHaveCount(2);
  await noHorizontalScroll(page);
});

test('a merchant who lost the Paystack link gets a new one, pays it, and the plan switches on once', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Recovery ${RUN}-${seq}`);
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const first = await openPaystack(page);

  // The merchant closes Paystack's page without paying and comes back later. A link asked for
  // again within thirty seconds is the same link; this one has sat idle for longer than that.
  await sql`UPDATE subscription_charge_attempts SET updated_at = updated_at - interval '2 minutes'
            WHERE business_id = ${businessId}::uuid`;
  await page.goto('/app/billing');
  await expect(page.locator('#pay')).toContainText(first);
  await page.getByRole('button', { name: 'I lost my payment link' }).click();

  // Rekoda asked Paystack about the old session (not paid) and opened a new one, for the same
  // payment, under a new reference Paystack has not seen.
  await expect(page.getByRole('heading', { name: 'Fake Paystack checkout' })).toBeVisible();
  const recovered = (await page.locator('[data-ref]').textContent())!.trim();
  expect(recovered).toBe(`${first}-R2`);
  await payAndReturn(page, request, recovered);

  // One payment, applied once: one charge, paid; one month of service.
  const facts = async () => {
    const [facts] = await sql<
      { charges: number; paid: number; plan: string; days: number; attempts: string[] }[]
    >`SELECT (SELECT count(*)::int FROM subscription_charges WHERE business_id = b.id) AS charges,
             (SELECT count(*)::int FROM subscription_charges
               WHERE business_id = b.id AND status = 'paid') AS paid,
             b.plan,
             (extract(epoch FROM (b.plan_expires_at - now())) / 86400)::int AS days,
             (SELECT array_agg(provider_reference || ':' || status ORDER BY attempt_no)
                FROM subscription_charge_attempts WHERE business_id = b.id) AS attempts
      FROM businesses b WHERE b.id = ${businessId}::uuid`;
    return facts!;
  };
  const after = await facts();
  expect(after).toMatchObject({ charges: 1, paid: 1, plan: 'chat' });
  expect(after.days).toBeGreaterThanOrEqual(27);
  expect(after.days).toBeLessThanOrEqual(32);
  expect(after.attempts).toHaveLength(2);
  expect(after.attempts[1]).toBe(`${recovered}:paid`);

  await page.getByRole('link', { name: 'Back to billing' }).click();
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');
  // The history shows the one payment, under the reference it was raised with, as paid.
  await expect(historyRows(page)).toHaveCount(1);
  await expect(row(page, first).getByRole('cell', { name: 'Paid' })).toBeVisible();
  await expect(page.locator('#pay')).toHaveCount(0);

  // Give a (wrong) second application time to show, then compare.
  await page.waitForTimeout(2_000);
  expect(await facts()).toEqual(after);
});

/** An invited member signs in on their own phone, in their own browser, at this project's size. */
async function signInMember(browser: Browser, memberPhone: string): Promise<Page> {
  const context = await browser.newContext({ viewport: test.info().project.use.viewport! });
  const member = await context.newPage();
  await member.goto('/start');
  await member.fill('#phone', memberPhone);
  await member.click('button[type=submit]');
  await expect(member).toHaveURL(/\/verify/);
  const code = (await member.locator('[data-e2e-otp]').getAttribute('data-e2e-otp'))!;
  await member.fill('#code', code);
  await member.click('button[type=submit]');
  await expect(member).toHaveURL(/\/app/);
  return member;
}

test("an accountant sees the plan, the history and what is waiting, and none of the owner's controls", async ({
  page,
  browser,
  request,
}) => {
  await onboard(page, `Ada Books ${RUN}-${seq}`);
  const accountantPhone = freshPhone('0812');
  await page.goto('/app/team');
  await page.fill('#phone', accountantPhone);
  await page.selectOption('#role', 'accountant');
  await page.getByRole('button', { name: 'Add them' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added.' })).toBeVisible();

  // The owner is on Chat, and has started buying a pack without paying for it yet.
  await page.goto('/app/billing?to=chat');
  await page.getByRole('button', { name: 'Confirm and pay' }).click();
  const plan = await openPaystack(page);
  await payAndReturn(page, request, plan);
  await page.goto('/app/billing');
  await page
    .getByRole('row', { name: /50 extra document generations/ })
    .getByRole('button', { name: 'Buy' })
    .click();
  await page.waitForURL(/[?&]pay=/);
  const pack = (await page.locator('#pay .rk-mono').textContent())!.trim();

  const accountant = await signInMember(browser, accountantPhone);
  try {
    await accountant.goto('/app/billing');
    await expect(accountant.locator('.rk-plan-current')).toContainText('Rekoda Chat');
    await expect(row(accountant, plan).getByRole('cell', { name: 'Paid' })).toBeVisible();

    // The waiting pack is shown, and paying it is the owner's.
    const pay = accountant.locator('#pay');
    await expect(pay.getByRole('heading', { name: 'Pay for your add-on' })).toBeVisible();
    await expect(pay).toContainText(pack);
    await expect(pay.getByText('Payments are the owner’s to make.', { exact: true })).toBeVisible();
    await expect(accountant.getByRole('button', { name: 'Pay with Paystack' })).toHaveCount(0);
    await expect(accountant.getByRole('button', { name: 'I lost my payment link' })).toHaveCount(0);
    await expect(
      row(accountant, pack).getByRole('cell', { name: 'Awaiting payment' }),
    ).toBeVisible();

    // Packs are listed for reading, each one the owner's to buy.
    const packs = accountant
      .locator('.rk-card')
      .filter({ has: accountant.getByRole('heading', { name: 'Need more this month' }) });
    await expect(packs.locator('tbody tr').first()).toBeVisible();
    const packCount = await packs.locator('tbody tr').count();
    await expect(packs.getByText('Owner only', { exact: true })).toHaveCount(packCount);
    await expect(accountant.getByRole('button', { name: 'Buy' })).toHaveCount(0);

    // No billing email, frequency switch or cancellation for a non-owner.
    await expect(accountant.getByRole('heading', { name: 'Billing email' })).toHaveCount(0);
    await expect(accountant.getByRole('heading', { name: 'Billing frequency' })).toHaveCount(0);
    await expect(accountant.getByRole('heading', { name: 'Leaving Rekoda' })).toHaveCount(0);
    await expect(accountant.getByText('Cancel my subscription')).toHaveCount(0);
    await expect(accountant.getByRole('button', { name: /at my next renewal/ })).toHaveCount(0);

    // A plan change can be priced but not confirmed.
    await accountant.goto('/app/billing?to=integrate');
    await expect(
      accountant.getByRole('heading', { name: 'Moving to Rekoda Integrate' }),
    ).toBeVisible();
    await expect(
      accountant.getByText('Plan changes are the owner’s to confirm.', { exact: true }),
    ).toBeVisible();
    await expect(accountant.getByRole('button', { name: /Confirm/ })).toHaveCount(0);
    await expect(accountant.getByRole('button', { name: /Cancel/ })).toHaveCount(0);
    await expect(accountant.getByRole('button', { name: 'Buy' })).toHaveCount(0);
    await noHorizontalScroll(accountant);
  } finally {
    await accountant.context().close();
  }
});
