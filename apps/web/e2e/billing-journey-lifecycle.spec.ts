/**
 * What a merchant sees when a payment does not go to plan, in a real browser (billing Slice B).
 *
 * Complements billing-journey.spec.ts (the happy paths) and the integration suites (#338, #339,
 * the annual lifecycle): a declined card and a second try, a late payment on a checkout the
 * merchant had already replaced, a refund, and a lapsed plan restarted by paying. Same stack as
 * the happy path: Rekoda's real API, worker and database, with Paystack itself a stand-in
 * (e2e/support/fake-paystack.mjs). A refund and a lapse are put in the database directly, because
 * the operator route and the clock are not what is under test here; the integration suites cover
 * the code that writes them. Real Paystack test mode is a staging step, not claimed here.
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
/** A block of numbers apart from billing-journey.spec.ts (0818...), and one per project. */
const freshPhone = () =>
  `0819${RUN}${String(1000 + seq++ + (test.info().project.name === 'desktop' ? 500 : 0)).slice(-4)}`;

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

/** The signed webhook Paystack sends, for the customer who paid or whose card was declined. */
async function sendEvent(
  request: APIRequestContext,
  type: 'charge.success' | 'charge.failed',
  reference: string,
  amount: number,
) {
  const raw = JSON.stringify({
    event: type,
    data: {
      id: Date.now() + seq++,
      reference,
      amount,
      currency: 'NGN',
      status: type === 'charge.success' ? 'success' : 'failed',
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

async function customerPays(request: APIRequestContext, reference: string) {
  const paid = await request.post(`${FAKE_PAYSTACK}/__pay/${reference}`);
  const { amount } = (await paid.json()) as { amount: number };
  await sendEvent(request, 'charge.success', reference, amount);
}

async function customerIsDeclined(request: APIRequestContext, reference: string) {
  const declined = await request.post(`${FAKE_PAYSTACK}/__fail/${reference}`);
  const { amount } = (await declined.json()) as { amount: number };
  await sendEvent(request, 'charge.failed', reference, amount);
}

/** Choose a plan and open Paystack's page; returns the reference the merchant is paying. */
async function openCheckout(page: Page, plan: string): Promise<string> {
  await page.goto(`/app/billing?to=${plan}`);
  await page.getByRole('button', { name: /Confirm and pay/ }).click();
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

const chargeOf = async (reference: string) => {
  const [row] = await sql<
    { status: string; unapplied: boolean; amount: number }[]
  >`SELECT status, unapplied_at IS NOT NULL AS unapplied, amount_k::int AS amount
      FROM subscription_charges WHERE reference = ${reference}`;
  return row;
};

const row = (page: Page, reference: string) => page.getByRole('row').filter({ hasText: reference });

test('a declined card is recorded as failed, changes nothing, and a second try works', async ({
  page,
  request,
}) => {
  await onboard(page, `Ada Declined ${RUN}-${seq}`);
  const first = await openCheckout(page, 'chat');

  await customerIsDeclined(request, first);
  await expect
    .poll(async () => (await chargeOf(first))?.status, { timeout: 30_000 })
    .toBe('failed');

  // The merchant is back on a trial: nothing was bought and nothing is claimed.
  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toContainText('Free trial');
  await expect(
    row(page, first).getByRole('cell', { name: 'Payment did not go through' }),
  ).toBeVisible();

  // Its record says the same, plainly, and does not call it paid.
  await page.getByRole('link', { name: first }).click();
  await expect(page.getByRole('heading', { name: 'Payment did not go through' })).toBeVisible();
  await expect(page.getByText('Not confirmed')).toBeVisible();
  await expect(page.getByText('Confirmed by Paystack')).toHaveCount(0);

  // A fresh attempt is a new payment with its own reference, and it works.
  const second = await openCheckout(page, 'chat');
  expect(second).not.toBe(first);
  await payAndReturn(page, request, second);
  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');
  await expect(row(page, second).getByRole('cell', { name: 'Paid' })).toBeVisible();
  await expect(
    row(page, first).getByRole('cell', { name: 'Payment did not go through' }),
  ).toBeVisible();
});

test('a payment on a checkout the merchant had replaced is kept as money received, and changes no plan', async ({
  page,
  request,
}) => {
  await onboard(page, `Ada Late ${RUN}-${seq}`);
  // The merchant starts paying for Chat, then decides on Integrate and pays for that.
  const replaced = await openCheckout(page, 'chat');
  const current = await openCheckout(page, 'integrate');
  expect(current).not.toBe(replaced);
  await payAndReturn(page, request, current);

  // The old Chat checkout is still open in another tab, and the merchant pays on it.
  await customerPays(request, replaced);
  await expect
    .poll(async () => (await chargeOf(replaced))?.status, { timeout: 30_000 })
    .toBe('paid');
  expect((await chargeOf(replaced))?.unapplied).toBe(true);

  // The plan is still the one chosen last. Nothing was downgraded or doubled.
  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Integrate');

  // The payment is in the history as money received, and its record says it was not applied.
  await page.getByRole('link', { name: replaced }).click();
  await expect(page.getByRole('heading', { name: 'Payment received, not applied' })).toBeVisible();
  await expect(page.getByText(/your plan changed after this payment was started/)).toBeVisible();
  await expect(page.locator('dd', { hasText: /^No$/ })).toBeVisible();
  await expect(page.getByText('Confirmed by Paystack')).toBeVisible();

  // The paid Integrate payment is applied.
  await page.goto('/app/billing');
  await page.getByRole('link', { name: current }).click();
  await expect(page.locator('[data-state=paid_applied]')).toBeVisible();
});

test('a refund is shown as a refund and the plan the merchant paid for stays', async ({
  page,
  request,
}) => {
  await onboard(page, `Ada Refund ${RUN}-${seq}`);
  const reference = await openCheckout(page, 'chat');
  await payAndReturn(page, request, reference);

  // An operator refund (the route is covered by its own tests) returns the money in full.
  await sql`UPDATE subscription_charges
            SET status = 'refunded', refunded_amount_k = amount_k, refunded_at = now()
            WHERE reference = ${reference}`;

  await page.goto('/app/billing');
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');
  await expect(row(page, reference).getByRole('cell', { name: 'Refunded' })).toBeVisible();

  await page.getByRole('link', { name: reference }).click();
  await expect(page.getByRole('heading', { name: 'Refunded', exact: true })).toBeVisible();
  await expect(page.locator('dt', { hasText: 'Returned to you' })).toBeVisible();
  // The plan really was applied; returning the money did not un-apply it.
  await expect(page.locator('dd', { hasText: /^Yes$/ })).toBeVisible();
});

test('a lapsed plan is restarted by paying, and no second trial is given', async ({
  page,
  request,
}) => {
  const businessId = await onboard(page, `Ada Lapsed ${RUN}-${seq}`);
  const first = await openCheckout(page, 'chat');
  await payAndReturn(page, request, first);

  // The paid month passes (forty days ago, so the new purchase is a new cycle) and the grace
  // sweep has expired the plan.
  await sql`UPDATE subscription_charges
            SET period_start = period_start - interval '40 days',
                period_end = period_end - interval '40 days',
                created_at = created_at - interval '40 days',
                paid_at = paid_at - interval '40 days'
            WHERE reference = ${first}`;
  await sql`UPDATE businesses
            SET plan = 'expired', plan_expires_at = now() - interval '10 days',
                payment_failed_at = now() - interval '10 days'
            WHERE id = ${businessId}::uuid`;

  await page.goto('/app/billing');
  await expect(page.getByText(/Your subscription stopped on/)).toBeVisible();
  await expect(page.getByText('Free trial')).toHaveCount(0);

  // Paying for a plan again brings it back.
  const second = await openCheckout(page, 'chat');
  await payAndReturn(page, request, second);
  await page.goto('/app/billing');
  await expect(page.getByText(/Your subscription stopped on/)).toHaveCount(0);
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');
  await expect(page.getByText('Free trial')).toHaveCount(0);
  await expect(row(page, first).getByRole('cell', { name: 'Paid' })).toBeVisible();
  await expect(row(page, second).getByRole('cell', { name: 'Paid' })).toBeVisible();
});
