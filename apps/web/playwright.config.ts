import { defineConfig } from '@playwright/test';

/**
 * The web app has no unit tests — its behaviour lives in routing, guards and
 * server actions, which only a real browser exercises. These run against a
 * PRODUCTION build so the assertions cover what actually ships: dev-only OTP
 * logging is off, cookies are set the way they will be, and NODE_ENV branches
 * take their production path.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // the dev store is a single in-memory map
  forbidOnly: !!process.env.CI,
  retries: 0,
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
  webServer: {
    command: 'pnpm exec next start -p 3100',
    url: 'http://127.0.0.1:3100/start',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Both secrets are required in production; supplying them here is what
      // lets the suite exercise the production code path at all.
      REKODA_SESSION_SECRET: 'e2e-session-secret-at-least-thirty-two-chars',
      OTP_PEPPER: 'e2e-otp-pepper-at-least-thirty-two-characters',
      REKODA_E2E_REVEAL_OTP: '1',
    },
  },
});
