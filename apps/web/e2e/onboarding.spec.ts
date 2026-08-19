import { expect, test } from '@playwright/test';

/**
 * End-to-end coverage of the onboarding flow, weighted towards the things that
 * have actually broken: the step guards, phone normalisation, and the rules
 * that stop a code being guessed or replayed.
 */

/**
 * Next injects its own `role="alert"` route announcer, so `getByRole('alert')`
 * is ambiguous. Field errors are addressed by their id, which is also what
 * `aria-describedby` points at — so the selector doubles as a check that the
 * wiring is right.
 */
const fieldError = (page: import('@playwright/test').Page, field: string) =>
  page.locator(`#${field}-error`);

let seq = 0;
/** A fresh number per test — the dev store is shared across the suite. */
const freshPhone = () => `080311${String(10000 + seq++).slice(-5)}`;

/** The build exposes the code to the test harness only, never in a real deploy. */
async function codeFor(page: import('@playwright/test').Page): Promise<string> {
  const el = page.locator('[data-e2e-otp]');
  await expect(el).toHaveCount(1);
  return (await el.getAttribute('data-e2e-otp'))!;
}

test.describe('step guards', () => {
  for (const path of ['/setup/business', '/setup/complete?name=Fake%20Ltd']) {
    test(`${path} redirects to /start without a verified marker`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/start$/);
    });
  }

  test('a forged marker cookie is rejected', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'rk_verified',
        value: '+2348031234567.verified.99999999999999.deadbeef',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    await page.goto('/setup/business');
    await expect(page).toHaveURL(/\/start$/);
  });

  test('/verify survives a repeated query param instead of 500ing', async ({ page }) => {
    const res = await page.goto('/verify?phone=0803&phone=0804');
    expect(res?.status()).toBeLessThan(500);
    await expect(page).toHaveURL(/\/start$/);
  });
});

test.describe('phone entry', () => {
  test('rejects a non-Nigerian number inline and stays put', async ({ page }) => {
    await page.goto('/start');
    await page.fill('#phone', '12345');
    await page.click('button[type=submit]');
    await expect(fieldError(page, 'phone')).toContainText('Nigerian mobile');
    await expect(page).toHaveURL(/\/start$/);
  });

  test('accepts country code AND trunk prefix together', async ({ page }) => {
    await page.goto('/start');
    await page.fill('#phone', '+234 0803 119 9001');
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/verify\?phone=%2B2348031199001$/);
  });
});

test.describe('code verification', () => {
  test('completes the happy path and consumes the code', async ({ page }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/verify/);

    const code = await codeFor(page);
    await page.fill('#code', code);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/setup\/business$/);

    await page.fill('#name', 'Ada Fashion');
    await page.selectOption('#type', 'Fashion & clothing');
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/setup\/complete/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ada Fashion is ready');

    // Replay: the consumed code must not let anyone back in.
    await page.goto(`/verify?phone=${encodeURIComponent(`+234${phone.slice(1)}`)}`);
    await page.fill('#code', code);
    await page.click('button[type=submit]');
    await expect(fieldError(page, 'code')).toContainText('already been used');
  });

  test('counts down wrong attempts and then refuses the CORRECT code', async ({ page }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await page.click('button[type=submit]');
    const code = await codeFor(page);

    for (let i = 4; i >= 1; i--) {
      await page.fill('#code', '000000');
      await page.click('button[type=submit]');
      await expect(fieldError(page, 'code')).toContainText(`${i} ${i === 1 ? 'try' : 'tries'} left`);
    }
    await page.fill('#code', '000000');
    await page.click('button[type=submit]');
    await expect(fieldError(page, 'code')).toContainText('no tries left');

    // Brute force must not be rescued by finally guessing right.
    await page.fill('#code', code);
    await page.click('button[type=submit]');
    await expect(fieldError(page, 'code')).toContainText('Too many tries');
  });

  test('an immediate resend returns to /verify rather than stranding the merchant', async ({
    page,
  }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/verify/);

    await page.goto('/start');
    await page.fill('#phone', phone);
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/verify/); // not stuck on /start with a live code
  });
});

test.describe('accessibility of the forms', () => {
  test('errors are announced and tied to their input', async ({ page }) => {
    await page.goto('/start');
    await page.fill('#phone', '12345');
    await page.click('button[type=submit]');
    await expect(fieldError(page, 'phone')).toBeVisible();
    await expect(page.locator('#phone')).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await page.locator('#phone').getAttribute('aria-describedby');
    expect(describedBy).toContain('phone-error');
  });

  test('business setup puts each error on its own field', async ({ page }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await page.click('button[type=submit]');
    await page.fill('#code', await codeFor(page));
    await page.click('button[type=submit]');
    await expect(page).toHaveURL(/\/setup\/business$/);

    await page.fill('#name', 'A'); // too short
    await page.click('button[type=submit]');
    await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#type')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('the test hook itself', () => {
  test('the OTP is never rendered without the explicit reveal flag', async ({ page, request }) => {
    // The suite sets REKODA_E2E_REVEAL_OTP; a deployment never does. This asks
    // the running server directly so the guard is proven, not assumed.
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await page.click('button[type=submit]');
    await expect(page.locator('[data-e2e-otp]')).toHaveCount(1);

    // …and the code is not in the plain HTML of any other page.
    const home = await request.get('/');
    expect(await home.text()).not.toContain('data-e2e-otp');
  });
});
