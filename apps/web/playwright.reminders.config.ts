import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';

/**
 * The merchant reminder screens (REM-06), end to end: Next.js, the Nest API and PostgreSQL, as
 * production builds, like the main suite.
 *
 * Its own API because reminders need settings the main suite must not have: customer reminders
 * released (`REKODA_CUSTOMER_REMINDERS=1`, which requires an https `REKODA_WEB_URL` for the
 * opt-out link) and the in-memory mock email sender, which would change what the billing email
 * card in the main suite says. Nothing leaves the machine: the mock keeps mail in memory, no
 * WhatsApp connection exists, and the API refuses the mock in production. No worker runs, so a
 * confirmed batch stays waiting until the test cancels it; the worker's sends are proven by
 * reminder-batch.integration.test.ts.
 *
 * It needs a database of its own (CI creates `rekoda_reminders`): the vault key below is random
 * per run, and the spec seals a customer's email address with it the way the API would.
 * Before a second local run, drop and recreate `rekoda_reminders`: the API rejects a new key when
 * the database already holds a different enrolled fingerprint.
 */
/* Both or neither (an empty value counts as unset, here and in the fallbacks below): one override
 * alone would migrate one database and run the API on another. */
if (Boolean(process.env.APP_DATABASE_URL) !== Boolean(process.env.DATABASE_URL)) {
  throw new Error(
    'Set DATABASE_URL (owner) and APP_DATABASE_URL (rekoda_app) together for the reminder suite, or neither.',
  );
}
const DATABASE_URL =
  process.env.APP_DATABASE_URL || 'postgres://rekoda_app@127.0.0.1:5432/rekoda_reminders';
const OWNER_DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://rekoda@127.0.0.1:5432/rekoda_reminders';
const API_PORT = 3121;
const WEB_PORT = 3120;

const ephemeralSecret = () => randomBytes(24).toString('hex');
const ephemeralKey = () => randomBytes(32).toString('hex');

/**
 * Shared with the spec through the environment so it can seal a customer's email address as the
 * API does. `??=` because Playwright loads this file again in each test worker, which must see
 * the main process's key.
 */
process.env.REKODA_E2E_VAULT_KEY ??= ephemeralKey();
process.env.REKODA_E2E_API_URL ??= `http://127.0.0.1:${API_PORT}`;

// Empty string means "use Playwright's own download" (CI); unset falls back to the container's
// pre-installed Chromium (this environment).
const browserLaunch =
  process.env.REKODA_CHROME === ''
    ? {}
    : {
        launchOptions: {
          executablePath:
            process.env.REKODA_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        },
      };

export default defineConfig({
  testDir: './e2e',
  testMatch: /reminders\.spec\.ts/,
  fullyParallel: false,
  // One at a time: both viewports share one API and one database.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  globalTimeout: 15 * 60_000,
  reporter: process.env.CI ? 'list' : 'line',
  /* Not test-results/, which CI uploads when a run fails: the error context Playwright writes there
   * holds a snapshot of the page, with the same customer details. The failure itself is still
   * printed in the job log. */
  outputDir: 'test-results-reminders',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    /* Off, unlike the other suites: this one types customer names, an email address and phone
     * numbers, and a trace would carry them. */
    trace: 'off',
  },
  projects: [
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, ...browserLaunch } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 }, ...browserLaunch } },
  ],
  webServer: [
    {
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
        VAULT_KEY: process.env.REKODA_E2E_VAULT_KEY,
        MATCH_KEY: ephemeralKey(),
        CONNECTION_KEY: ephemeralKey(),
        // One per-IP budget for the whole run (every request arrives from the Next server).
        REKODA_RATE_LIMIT_MAX: '2000',
        // Returns the code in the response; the API refuses this when NODE_ENV is production.
        REKODA_REVEAL_OTP: '1',
        // Reminders released, with the https origin their opt-out link needs, and mail kept in
        // memory. Never a real send.
        REKODA_CUSTOMER_REMINDERS: '1',
        REKODA_WEB_URL: 'https://rekoda.app',
        REKODA_EMAIL_PROVIDER: 'mock',
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
        REKODA_E2E_PLACEHOLDER_LEGAL: '1',
        NEXT_PUBLIC_SITE_URL: 'https://rekoda.app',
      },
    },
  ],
});
