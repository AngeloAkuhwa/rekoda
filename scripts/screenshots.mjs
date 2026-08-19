/**
 * UI review harness. Every UI PR ships screenshots — light + dark × mobile +
 * desktop (design-system/rekoda/MASTER.md §8).
 *
 *   pnpm turbo build
 *   # API on :3001 with REKODA_REVEAL_OTP=1, web on :3000 with
 *   # REKODA_E2E_REVEAL_OTP=1 and REKODA_API_URL pointed at it
 *   node scripts/screenshots.mjs [outDir]
 *
 * The onboarding shots are taken by WALKING the flow, not by navigating to
 * each step's URL. That distinction is the whole reason this file was
 * rewritten: once the step guards became real (a signed grant checked against
 * the API, rather than a query parameter), navigating straight to
 * `/setup/business` began redirecting to `/start` — so the harness happily
 * wrote eight screenshots of the wrong page under onboarding names and printed
 * a tick for each. A screenshot tool that cannot tell you it photographed the
 * wrong page is worse than none.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.argv[2] ?? '.screenshots';
const BASE = process.env.REKODA_WEB_URL ?? 'http://127.0.0.1:3000';
const CHROME = process.env.REKODA_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** 360 is the real floor; the skill's checklist also asks for 375. */
const VIEWPORTS = [
  { label: 'mobile', width: 390, height: 900 },
  { label: 'desktop', width: 1280, height: 1150 },
];
const THEMES = ['light', 'dark'];

/** Pages reachable without a session. */
const PUBLIC_ROUTES = [
  { name: 'home', path: '/' },
  { name: 'pricing', path: '/pricing' },
];

/** A fresh number per run — these are rows now, and they outlive the process. */
let seq = 0;
const runPrefix = String(Math.floor(Math.random() * 900) + 100);
const freshPhone = () => `0803${runPrefix}${String(1000 + seq++).slice(-4)}`;

async function shoot(page, name, vp, theme) {
  const file = `${OUT}/${name}-${vp.label}-${theme}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log('✓', file);
}

/** Walks phone → code → business → dashboard, capturing each real screen. */
async function walkOnboarding(ctx, vp, theme) {
  const page = await ctx.newPage();
  const phone = freshPhone();

  await page.goto(`${BASE}/start`, { waitUntil: 'networkidle' });
  await shoot(page, 'onboard-1-start', vp, theme);

  await page.fill('#phone', phone);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/verify/);
  await shoot(page, 'onboard-2-verify', vp, theme);

  const code = await page.locator('[data-e2e-otp]').getAttribute('data-e2e-otp');
  if (!code) throw new Error('OTP not revealed — is REKODA_REVEAL_OTP=1 set on the API?');
  await page.fill('#code', code);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/setup\/business$/);
  await shoot(page, 'onboard-3-business', vp, theme);

  await page.fill('#name', 'Ada Fashion');
  await page.selectOption('#type', 'Fashion & clothing');
  await page.click('button[type=submit]');
  await page.waitForURL(/\/setup\/complete$/);
  await shoot(page, 'onboard-4-complete', vp, theme);

  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.waitForURL(/\/app$/);
  await shoot(page, 'dashboard', vp, theme);

  await page.close();
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('rk-theme', t);
      } catch {
        /* private mode */
      }
    }, theme);

    for (const route of PUBLIC_ROUTES) {
      const page = await ctx.newPage();
      await page.goto(BASE + route.path, { waitUntil: 'networkidle' });
      await shoot(page, route.name, vp, theme);
      await page.close();
    }

    await walkOnboarding(ctx, vp, theme);
    await ctx.close();
  }
}

await browser.close();
