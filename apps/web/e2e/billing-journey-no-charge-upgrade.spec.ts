/**
 * F-2 (owner instruction, 18 Nov 2026), in a real browser: after a zero-priced upgrade the page was
 * told is still `processing`, a refresh shows what actually became of it.
 *
 * Same stack as the other billing journeys: Rekoda's real API, worker and settlement runner, and the
 * database. The upgrade request is arranged in the database exactly as the API writes it (a pending
 * ₦0 upgrade charge and its `billing.apply_no_charge` job) because the moment under test is the
 * refresh after the API's short wait has ended. The job is held back by its run time, so the page is
 * seen while settlement has not run it; then it is released and the real settlement runner switches
 * the plan on (delayed completion). A withdrawn request and one whose job stopped are arranged the
 * way settlement leaves them.
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

const OWNER_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rekoda@127.0.0.1:5432/rekoda';
const sql = postgres(OWNER_DATABASE_URL, { max: 2, onnotice: () => {} });
test.afterAll(async () => {
  await sql.end();
});

const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
/** A block of numbers apart from the other journey specs (0806..., 0818..., 0819...). */
const freshPhone = () =>
  `0807${RUN}${String(1000 + seq++ + (test.info().project.name === 'desktop' ? 500 : 0)).slice(-4)}`;

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

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const mintReference = () =>
  `RKD-SUB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${[...randomBytes(6)]
    .map((byte) => ALPHABET[byte % 32])
    .join('')}`;

/**
 * A Chat subscriber ten hours before renewal (an upgrade costs nothing) who has just asked for
 * Complete: the ₦0 upgrade charge and its settlement job, as the API writes them. The job runs at
 * `runAt` (in the future: settlement has not got to it yet) and in `state`.
 */
async function askedForFreeUpgrade(
  businessId: string,
  job: { state: 'pending' | 'dead'; runAt: 'later' | 'now' },
): Promise<string> {
  const reference = mintReference();
  await sql.begin(async (tx) => {
    const [{ renews, start, day }] = await tx<{ renews: Date; start: Date; day: number }[]>`
      SELECT now() + interval '10 hours' AS renews,
             now() + interval '10 hours' - interval '30 days' AS start,
             extract(day FROM (now() + interval '10 hours') AT TIME ZONE 'Africa/Lagos')::int AS day`;
    await tx`UPDATE businesses
             SET plan = 'chat',
                 plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = 'chat'
                                    ORDER BY version DESC LIMIT 1),
                 plan_expires_at = ${renews}, cycle_started_at = ${start},
                 renewal_anchor_day = ${day}, billing_interval = 'monthly',
                 subscription_origin = 'provider', ever_paid_at = ${start},
                 plan_decided_at = ${start}
             WHERE id = ${businessId}::uuid`;
    await tx`INSERT INTO subscription_charges
               (business_id, kind, plan, quantity, amount_k, reference, period_start, period_end,
                billing_interval, pricing_source)
             VALUES (${businessId}::uuid, 'upgrade', 'complete', 1, 0, ${reference}, ${start},
                     ${renews}, 'monthly',
                     (SELECT mode FROM billing_pricing_source))`;
    await tx`INSERT INTO jobs (business_id, kind, payload, singleton_key, state, run_at, attempts)
             VALUES (${businessId}::uuid, 'billing.apply_no_charge',
                     ${tx.json({ reference })}, ${'no-charge:' + reference}, ${job.state},
                     ${job.runAt === 'later' ? tx`now() + interval '1 hour'` : tx`now()`},
                     ${job.state === 'dead' ? 5 : 0})`;
  });
  return reference;
}

const strip = (page: Page) => page.locator('[data-no-charge-upgrade]');

test('a refresh while settlement has not run says so, and once it has, says the plan is on', async ({
  page,
}) => {
  const businessId = await onboard(page, `Ada Free Upgrade ${RUN}-${seq}`);
  const reference = await askedForFreeUpgrade(businessId, { state: 'pending', runAt: 'later' });

  await page.goto('/app/billing?done=processing');
  await expect(strip(page)).toHaveText(
    'We are switching your plan on now. Nothing was charged and your renewal date stays the same. Refresh this page in a moment to see your new plan.',
  );
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');

  // Settlement gets to it after the API's wait has ended.
  await sql`UPDATE jobs SET run_at = now() WHERE singleton_key = ${'no-charge:' + reference}`;
  await expect
    .poll(
      async () =>
        (await sql`SELECT status FROM subscription_charges WHERE reference = ${reference}`)[0]?.[
          'status'
        ],
      { timeout: 45_000 },
    )
    .toBe('paid');

  await page.reload();
  await expect(strip(page)).toHaveText(
    'Done. Your new plan is on now. Nothing was charged and your renewal date has not changed.',
  );
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Complete');
});

test('a refresh after the request stopped, or was withdrawn, says the plan has not changed', async ({
  page,
}) => {
  const businessId = await onboard(page, `Ada Stopped Upgrade ${RUN}-${seq}`);
  const reference = await askedForFreeUpgrade(businessId, { state: 'dead', runAt: 'now' });

  await page.goto('/app/billing?done=processing');
  await expect(strip(page)).toHaveText(
    'We could not switch your plan on, so your plan has not changed. Nothing was charged. You can choose the plan again below, or message us on WhatsApp if it happens again.',
  );
  await expect(page.getByText(/switching your plan on now/)).toHaveCount(0);
  await expect(page.locator('.rk-plan-current')).toContainText('Rekoda Chat');

  // Withdrawn the way settlement withdraws one (G3-1): set aside, with its audit row.
  await sql.begin(async (tx) => {
    await tx`UPDATE subscription_charges SET superseded_at = now() WHERE reference = ${reference}`;
    await tx`INSERT INTO audit_events (business_id, actor, entity, entity_id, action, new_value, source_type)
             VALUES (${businessId}::uuid, 'system:no_charge_upgrade', 'subscription_charge',
                     ${reference}, 'no_charge_upgrade_withdrawn',
                     '{"outcome":"withdrawn","reason":"cycle_ended"}'::jsonb, 'system')`;
  });
  await page.reload();
  await expect(strip(page)).toHaveText(
    'That change could not be made in time, so your plan has not changed. Nothing was charged. Choose the plan again to see what it costs now.',
  );
  await expect(page.getByText(/did not go through|payment failed/i)).toHaveCount(0);
});
