/**
 * The complete first purchase, in a real browser: a new merchant picks a plan, pays on a
 * (stand-in) Paystack page, is sent back to Rekoda, sees the plan switch on, and a replayed
 * webhook changes nothing. Billing journeys 1 to 13 of the owner's list, against Rekoda's real
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
const freshPhone = () => `0818${RUN}${String(1000 + seq++).slice(-4)}`;

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

test('coming back to the payment page with a reference that is not yours shows nothing', async ({
  page,
}) => {
  await onboard(page, `Ada Stranger ${RUN}-${seq}`);
  await page.goto('/app/billing/return?reference=RKD-SUB-20260101-ZZZZZZ');
  await expect(page.getByRole('heading', { name: 'We could not find that payment' })).toBeVisible();
  await page.goto('/app/billing/return?reference=%3Cscript%3E');
  await expect(page.getByRole('heading', { name: 'We could not find that payment' })).toBeVisible();
});
