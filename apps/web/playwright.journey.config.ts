import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';

/**
 * The full stack, end to end: Next.js → the Nest API → PostgreSQL.
 *
 * Everything runs as a PRODUCTION build so the assertions cover what actually
 * ships — dev-only branches off, cookies set the way they will be, NODE_ENV
 * taking its production path. The API is a real process talking to a real
 * database, because after this milestone the properties worth testing (single
 * -use codes, attempt limits, revoked sessions) are all properties of rows.
 */
// No passwords in the defaults: the local database (docker-compose.dev.yml)
// and the CI service container both use trust auth on a loopback-only port,
// so there is no credential here to hardcode. Real deployments supply these.
const DATABASE_URL = process.env.APP_DATABASE_URL ?? 'postgres://rekoda_app@127.0.0.1:5432/rekoda';
const OWNER_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rekoda@127.0.0.1:5432/rekoda';
/** A principal's URL: its own variable, or the app URL with the role swapped (trust auth only). */
function principalUrl(appUrl: string, variable: string, role: string): string {
  const given = process.env[variable];
  if (given) return given;
  const url = new URL(appUrl);
  url.username = role;
  return url.toString();
}
const API_PORT = 3111;
const WEB_PORT = 3110;
const FAKE_PAYSTACK_PORT = 3199;
const WORKER_DATABASE_URL =
  process.env.WORKER_DATABASE_URL ?? 'postgres://rekoda_worker@127.0.0.1:5432/rekoda';

/**
 * Freshly generated per run, never written down.
 *
 * These were literals until a secret scanner correctly objected: a
 * high-entropy string assigned to something named `*_SECRET` is exactly what a
 * real leaked credential looks like, and a scanner that learns to ignore this
 * file is worth less on the day it matters. Generating them removes the
 * literal AND is stronger — no two runs share a signing key.
 */
const ephemeralSecret = () => randomBytes(24).toString('hex');
/** AES-256 and the match HMAC both want exactly 32 bytes, as 64 hex characters. */
const ephemeralKey = () => randomBytes(32).toString('hex');

/**
 * The Paystack TEST key the API signs and verifies with in this suite: a test-mode key shape so
 * nothing treats it as live, shared with the spec through the environment so the test can sign the
 * webhook the way Paystack does. `??=` because Playwright loads this file again in each test
 * worker, which must see the main process's key.
 */
process.env.REKODA_E2E_PAYSTACK_SECRET ??= `sk_test_${ephemeralSecret()}`;
process.env.REKODA_E2E_FAKE_PAYSTACK_URL ??= `http://127.0.0.1:${FAKE_PAYSTACK_PORT}`;
process.env.REKODA_E2E_API_URL ??= `http://127.0.0.1:${API_PORT}`;

/**
 * `reuseExistingServer` is FALSE everywhere, including locally, and that is
 * deliberate despite the slower iteration.
 *
 * Reuse means "if something is already answering on this port, trust it". It
 * cannot tell a server built from this branch from one left running by a
 * different branch — a stale process silently serves the wrong code and the
 * suite reports failures that belong to neither. A slow honest signal beats a
 * fast lying one; a port collision fails loudly instead.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /billing-journey.*\.spec\.ts/,
  fullyParallel: false,
  // One at a time: both viewports share one API, one worker and one stand-in Paystack.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  /**
   * Above Playwright's 30s default, deliberately. This is a full-stack journey:
   * onboarding, plan choice, checkout, and a wait of up to 45 seconds for the
   * payment to be confirmed. Each step is a real HTTP round trip to the API and a
   * query against Postgres, so an honest slow run is not mistaken for a hang.
   */
  timeout: 60_000,
  /**
   * A ceiling for the whole suite. Without one, a wedged server or a hung
   * navigation stalls CI until the runner's own six-hour limit — a failure
   * nobody sees for hours, reported as "still running".
   */
  globalTimeout: 15 * 60_000,
  reporter: process.env.CI ? 'list' : 'line',
  use: {
    baseURL: process.env.REKODA_WEB_URL ?? `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        // Empty string means "use Playwright's own download" (CI); unset falls
        // back to the container's pre-installed Chromium (this environment).
        ...(process.env.REKODA_CHROME === ''
          ? {}
          : {
              launchOptions: {
                executablePath:
                  process.env.REKODA_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
              },
            }),
      },
    },
    {
      name: 'desktop',
      use: {
        viewport: { width: 1280, height: 800 },
        // Empty string means "use Playwright's own download" (CI); unset falls
        // back to the container's pre-installed Chromium (this environment).
        ...(process.env.REKODA_CHROME === ''
          ? {}
          : {
              launchOptions: {
                executablePath:
                  process.env.REKODA_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
              },
            }),
      },
    },
  ],
  webServer: [
    {
      // A stand-in for Paystack's API and hosted page (this journey only).
      command: 'node e2e/support/fake-paystack.mjs',
      url: `http://127.0.0.1:${FAKE_PAYSTACK_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_PAYSTACK_PORT: String(FAKE_PAYSTACK_PORT) },
    },
    {
      // Migrations run as the OWNER and the API runs as `rekoda_app`, exactly
      // as they do in a deployment — so the RLS policies are live underneath
      // every assertion rather than bypassed by a superuser connection.
      command:
        `DATABASE_URL='${OWNER_DATABASE_URL}' pnpm --filter @rekoda/db migrate:apply && ` +
        `DATABASE_URL='${DATABASE_URL}' pnpm --filter @rekoda/api exec node dist/main.js`,
      cwd: '../..',
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        OTP_PEPPER: ephemeralSecret(),
        REKODA_API_SECRET: ephemeralSecret(),
        VAULT_KEY: ephemeralKey(),
        MATCH_KEY: ephemeralKey(),
        // The key the API needs to store a merchant's settlement details. Kept so this
        // API boots with the same secrets as the main suite; the Paystack settings for
        // this purchase journey are set further down.
        CONNECTION_KEY: ephemeralKey(),
        // Every request in this suite arrives from 127.0.0.1 through the Next
        // server, so the whole run shares ONE per-IP budget — and the default
        // 60/minute is sized for a person, not for a scripted journey repeated
        // in two viewports. The limiter itself is pinned by
        // auth.integration.test.ts; raising it here tests the product instead of
        // the throttle.
        REKODA_RATE_LIMIT_MAX: '2000',
        // Returns the code in the response so the suite can complete the flow
        // without a WhatsApp account. The API refuses this outright when
        // NODE_ENV is production.
        REKODA_REVEAL_OTP: '1',
        // Yearly billing is off in a real deployment until every process is annual-aware;
        // the suite exercises the screens it unlocks.
        REKODA_ANNUAL_BILLING: '1',
        // The purchase journey: a Paystack TEST key pointed at the stand-in, the platform model
        // confirmed so checkout opens, the web address so Paystack can send the merchant back,
        // and the worker in-process so a signed webhook is verified and applied for real.
        PAYSTACK_SECRET_KEY: process.env.REKODA_E2E_PAYSTACK_SECRET!,
        PAYSTACK_BASE_URL: process.env.REKODA_E2E_FAKE_PAYSTACK_URL!,
        REKODA_PAYSTACK_PLATFORM_CONFIRMED: '1',
        REKODA_WEB_URL: `http://127.0.0.1:${WEB_PORT}`,
        REKODA_WORKER: '1',
        WORKER_DATABASE_URL,
        // OD-37 (migration 0202): the settlement and billing-operator principals, never the app role.
        SETTLEMENT_DATABASE_URL: principalUrl(
          DATABASE_URL,
          'SETTLEMENT_DATABASE_URL',
          'rekoda_settlement',
        ),
        OPERATOR_DATABASE_URL: principalUrl(
          DATABASE_URL,
          'OPERATOR_DATABASE_URL',
          'rekoda_billing_operator',
        ),
      },
    },
    {
      command: `pnpm exec next start -p ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}/start`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        REKODA_API_URL: `http://127.0.0.1:${API_PORT}`,
        REKODA_E2E_REVEAL_OTP: '1',
        // The suite serves the production build without company facts, so
        // the legal pages render their honest "not set yet" badges. Only
        // this harness may skip the R8 boot gate (legal-gate.mjs); a real
        // deployment setting this has disabled a launch control.
        REKODA_E2E_PLACEHOLDER_LEGAL: '1',
        // Pinned so the robots/sitemap assertions test the real canonical
        // host rather than whatever the local default happens to be.
        NEXT_PUBLIC_SITE_URL: 'https://rekoda.app',
      },
    },
  ],
});
