/**
 * UI review harness. Every UI PR ships screenshots — light + dark × mobile +
 * desktop (design-system/rekoda/MASTER.md §8).
 *
 *   pnpm --filter @rekoda/web build && pnpm --filter @rekoda/web start &
 *   node scripts/screenshots.mjs [outDir]
 *
 * Uses the pre-installed Chromium rather than downloading one.
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
/** Every page ships a screenshot — onboarding included, since that is the
 *  flow most likely to break at 390px. Steps carry the query param their
 *  guard requires, otherwise they redirect to /start. */
const DEMO_PHONE = encodeURIComponent('+2348031234567');
const ROUTES = [
  { name: 'home', path: '/' },
  { name: 'pricing', path: '/pricing' },
  { name: 'onboard-1-start', path: '/start' },
  { name: 'onboard-2-verify', path: `/verify?phone=${DEMO_PHONE}` },
  { name: 'onboard-3-business', path: `/setup/business?phone=${DEMO_PHONE}` },
  { name: 'onboard-4-complete', path: '/setup/complete?name=Ada%20Fashion' },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });

for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
      });
      const page = await ctx.newPage();
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('rk-theme', t);
        } catch {
          /* private mode */
        }
      }, theme);
      await page.goto(BASE + route.path, { waitUntil: 'networkidle' });
      const file = `${OUT}/${route.name}-${vp.label}-${theme}.png`;
      await page.screenshot({ path: file });
      console.log('✓', file);
      await ctx.close();
    }
  }
}
await browser.close();
