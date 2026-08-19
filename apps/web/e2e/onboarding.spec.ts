import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end coverage of the identity flow, over the real stack: Next.js, the
 * Nest API and PostgreSQL.
 *
 * Weighted towards what has actually broken — step guards, phone normalisation
 * — and towards the rules that stop a code being guessed or replayed. Since the
 * store became real rows, the interesting assertions are ones an in-memory map
 * could not have made honestly: that a revoked session stays dead, and that a
 * returning merchant lands in their own business rather than a new one.
 */

/**
 * Next injects its own `role="alert"` route announcer, so `getByRole('alert')`
 * is ambiguous. Field errors are addressed by their id, which is also what
 * `aria-describedby` points at — so the selector doubles as a check that the
 * wiring is right.
 */
const fieldError = (page: Page, field: string) => page.locator(`#${field}-error`);

/**
 * Phone numbers are now rows that outlive the run, so a fixed sequence would
 * collide with the previous run's merchants and turn a first-time signup into a
 * returning sign-in. A per-run prefix keeps every test's number its own.
 */
const RUN = String(Math.floor(Math.random() * 900) + 100);
let seq = 0;
const freshPhone = () => `0803${RUN}${String(1000 + seq++).slice(-4)}`;
const e164 = (local: string) => `+234${local.slice(1)}`;

/** The build exposes the code to the test harness only, never in a real deploy. */
async function codeFor(page: Page): Promise<string> {
  const el = page.locator('[data-e2e-otp]');
  await expect(el).toHaveCount(1);
  return (await el.getAttribute('data-e2e-otp'))!;
}

async function submit(page: Page) {
  await page.click('button[type=submit]');
}

/** Phone → code → business, leaving the browser signed in. */
async function onboard(page: Page, phone: string, name = 'Ada Fashion') {
  await page.goto('/start');
  await page.fill('#phone', phone);
  await submit(page);
  await expect(page).toHaveURL(/\/verify/);

  await page.fill('#code', await codeFor(page));
  await submit(page);
  await expect(page).toHaveURL(/\/setup\/business$/);

  await page.fill('#name', name);
  await page.selectOption('#type', 'Fashion & clothing');
  await submit(page);
  await expect(page).toHaveURL(/\/setup\/complete$/);
}

test.describe('the page actually runs in the browser', () => {
  /**
   * This exists because a Content-Security-Policy broke the whole site
   * without breaking a single server-rendered page.
   *
   * Hashing the inline theme script made browsers ignore `unsafe-inline`,
   * which blocked Next's own bootstrap scripts. Hydration died, so every form
   * stopped working — while the HTML still rendered perfectly, every
   * screenshot looked right, and every server-side assertion passed. Only
   * something that clicks in a real browser can see it.
   */
  test('loads with no CSP violations and hydrates', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

    await page.goto('/');
    expect(problems).toEqual([]);

    // Interactivity is the proof. A <details> that opens is React hydrated.
    const faq = page.locator('.rk-faq-item').first();
    await faq.locator('summary').click();
    await expect(faq).toHaveAttribute('open', '');
  });

  test('the no-flash theme script survives the policy', async ({ page }) => {
    // Blocked, this leaves a dark-mode merchant with a white flash on every
    // navigation — cosmetic, invisible to server-side tests, and permanent.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('rk-theme', 'dark');
      } catch {
        /* private mode */
      }
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('public pages a merchant is promised', () => {
  // Every one of these was a 404 linked from the header or footer of every
  // page. For a product asking merchants to trust it with money, a dead
  // Privacy link is not a broken link — it is a reason not to sign up.
  for (const path of ['/security', '/privacy', '/terms', '/ai-privacy', '/data-deletion']) {
    test(`${path} is reachable`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test('every header and footer link resolves', async ({ page, request }) => {
    await page.goto('/');
    const hrefs = await page
      .locator('header a[href^="/"], footer a[href^="/"]')
      .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')!))]);
    expect(hrefs.length).toBeGreaterThan(3);
    for (const href of hrefs) {
      expect((await request.get(href)).status(), `${href} should not be dead`).toBeLessThan(400);
    }
  });

  test('robots.txt keeps crawlers out of merchant surfaces', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();
    for (const priv of ['/app', '/setup/', '/verify']) {
      expect(body).toContain(`Disallow: ${priv}`);
    }
    expect(body).toContain('Sitemap:');
  });

  test('the sitemap lists only public pages', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toContain('/pricing');
    // The inverse is the one that matters: an indexed dashboard URL.
    for (const priv of ['/app', '/setup', '/verify', '/start']) {
      expect(xml).not.toContain(`<loc>https://rekoda.app${priv}`);
    }
  });
});

test.describe('step guards', () => {
  for (const path of ['/setup/business', '/setup/complete', '/app']) {
    test(`${path} redirects to /start with no credential`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/start$/);
    });
  }

  test('a forged setup cookie is rejected by the API, not just unread', async ({
    page,
    context,
  }) => {
    // The web tier cannot verify this value — only the API holds the signing
    // secret — so the guard has to be a round trip. This is the test that says
    // it is one.
    await context.addCookies([
      {
        name: 'rk_setup',
        value: '00000000-0000-4000-8000-000000000000.KzIzNDgwMzEyMzQ1Njc.99999999999999.deadbeef',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    await page.goto('/setup/business');
    await expect(page).toHaveURL(/\/start$/);
  });

  test('a forged session cookie cannot reach the dashboard', async ({ page, context }) => {
    await context.addCookies([
      { name: 'rk_session', value: 'not-a-real-session-token', domain: '127.0.0.1', path: '/' },
    ]);
    await page.goto('/app');
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
    await submit(page);
    await expect(fieldError(page, 'phone')).toContainText('Nigerian mobile');
    await expect(page).toHaveURL(/\/start$/);
  });

  test('accepts country code AND trunk prefix together', async ({ page }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', `+234 ${phone}`);
    await submit(page);
    await expect(page).toHaveURL(
      new RegExp(`/verify\\?phone=${encodeURIComponent(e164(phone)).replace('+', '%2B')}$`),
    );
  });
});

test.describe('the onboarding journey', () => {
  test('runs from a phone number to an authenticated dashboard', async ({ page }) => {
    const phone = freshPhone();
    await onboard(page, phone, 'Ada Fashion');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ada Fashion is ready');

    await page.goto('/app');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ada Fashion');
    await expect(page.getByText(e164(phone))).toBeVisible();
  });

  test('refuses a code that has already been spent', async ({ page, context }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    const code = await codeFor(page);
    await page.fill('#code', code);
    await submit(page);
    await expect(page).toHaveURL(/\/setup\/business$/);

    // A fresh browser, so this is the code alone being replayed — not a
    // session that happens to still be lying around.
    await context.clearCookies();
    await page.goto(`/verify?phone=${encodeURIComponent(e164(phone))}`);
    await page.fill('#code', code);
    await submit(page);
    await expect(fieldError(page, 'code')).toContainText('expired or has already been used');
  });

  test('signs a returning merchant into the business they already have', async ({
    page,
    context,
  }) => {
    // The property that only real rows can prove: the second sign-in must find
    // the existing business rather than mint a second one with its own ledger.
    const phone = freshPhone();
    await onboard(page, phone, 'Bola Electronics');
    await context.clearCookies();

    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    await page.fill('#code', await codeFor(page));
    await submit(page);

    await expect(page).toHaveURL(/\/app$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bola Electronics');
  });

  test('never asks an informal merchant for CAC or TIN', async ({ page }) => {
    // ADR 0012: requiring registration would exclude exactly the merchants
    // Rekoda exists for, so the field must not be on the form at all.
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    await page.fill('#code', await codeFor(page));
    await submit(page);

    // Word boundaries matter: a bare `toContain('tin')` matches "setting".
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toMatch(/\bcac\b/);
    expect(body).not.toMatch(/\btin\b/);
    expect(body).not.toMatch(/\brc number\b/);
  });
});

test.describe('sessions', () => {
  test('signing out kills the session server-side, not just the cookie', async ({
    page,
    context,
  }) => {
    const phone = freshPhone();
    await onboard(page, phone);
    await page.goto('/app');

    const cookie = (await context.cookies()).find((c) => c.name === 'rk_session');
    expect(cookie?.value).toBeTruthy();

    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/$/);

    // Put the SAME token back. A logout that only dropped the cookie would let
    // this straight back in; the session row has to be revoked for it not to.
    await context.addCookies([
      { name: 'rk_session', value: cookie!.value, domain: '127.0.0.1', path: '/' },
    ]);
    await page.goto('/app');
    await expect(page).toHaveURL(/\/start$/);
  });
});

test.describe('OTP defences', () => {
  test('counts down wrong attempts and then refuses the CORRECT code', async ({ page }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    const code = await codeFor(page);

    for (let i = 4; i >= 1; i--) {
      await page.fill('#code', '000000');
      await submit(page);
      await expect(fieldError(page, 'code')).toContainText(
        `${i} ${i === 1 ? 'try' : 'tries'} left`,
      );
    }
    await page.fill('#code', '000000');
    await submit(page);
    await expect(fieldError(page, 'code')).toContainText('no tries left');

    // Brute force must not be rescued by finally guessing right.
    await page.fill('#code', code);
    await submit(page);
    await expect(fieldError(page, 'code')).toContainText('Too many tries');
  });

  test('an immediate resend returns to /verify rather than stranding the merchant', async ({
    page,
  }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    await expect(page).toHaveURL(/\/verify/);

    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    await expect(page).toHaveURL(/\/verify/); // not stuck on /start with a live code
  });
});

test.describe('accessibility of the forms', () => {
  test('errors are announced and tied to their input', async ({ page }) => {
    await page.goto('/start');
    await page.fill('#phone', '12345');
    await submit(page);
    await expect(fieldError(page, 'phone')).toBeVisible();
    await expect(page.locator('#phone')).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await page.locator('#phone').getAttribute('aria-describedby');
    expect(describedBy).toContain('phone-error');
  });

  test('business setup puts each error on its own field', async ({ page }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    await page.fill('#code', await codeFor(page));
    await submit(page);
    await expect(page).toHaveURL(/\/setup\/business$/);

    await page.fill('#name', 'A'); // too short
    await submit(page);
    await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#type')).not.toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('the test hook itself', () => {
  test('the OTP reaches the harness and nowhere else', async ({ page, request }) => {
    const phone = freshPhone();
    await page.goto('/start');
    await page.fill('#phone', phone);
    await submit(page);
    await expect(page.locator('[data-e2e-otp]')).toHaveCount(1);

    // The hook is gated on REKODA_E2E_REVEAL_OTP, which the suite sets and a
    // deployment never does. Assert it has not leaked onto public pages.
    const home = await request.get('/');
    expect(await home.text()).not.toContain('data-e2e-otp');
  });
});
