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
const API_PORT = 3101;

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

/**
 * `reuseExistingServer` is FALSE everywhere, including locally, and that is
 * deliberate despite the slower iteration.
 *
 * Reuse means "if something is already answering on this port, trust it". It
 * cannot tell a server built from this branch from one left running by a
 * different branch — so a stale process silently serves the wrong code and the
 * suite reports failures that belong to neither. That is not hypothetical: it
 * cost a whole investigation here, producing a confident and completely false
 * "Next 16 breaks 12 of 18 tests" when the tests pass. A slow honest signal
 * beats a fast lying one; a port collision now fails loudly instead.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  /**
   * Above Playwright's 30s default, deliberately. These are full-stack
   * journeys — the sign-out test alone makes six navigations, each a real HTTP
   * round trip to the API and a query against Postgres. The default budget is
   * sized for a single page interaction and turns an honest slow test into a
   * confusing timeout with no failure to read.
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
    baseURL: process.env.REKODA_WEB_URL ?? 'http://127.0.0.1:3100',
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
  ],
  webServer: [
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
        // Returns the code in the response so the suite can complete the flow
        // without a WhatsApp account. The API refuses this outright when
        // NODE_ENV is production.
        REKODA_REVEAL_OTP: '1',
      },
    },
    {
      command: 'pnpm exec next start -p 3100',
      url: 'http://127.0.0.1:3100/start',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        REKODA_API_URL: `http://127.0.0.1:${API_PORT}`,
        REKODA_E2E_REVEAL_OTP: '1',
        // Pinned so the robots/sitemap assertions test the real canonical
        // host rather than whatever the local default happens to be.
        NEXT_PUBLIC_SITE_URL: 'https://rekoda.app',
      },
    },
  ],
});
