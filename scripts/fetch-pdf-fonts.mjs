/**
 * Downloads the TTFs the PDF engine embeds.
 *
 * Separate from `fetch-fonts.mjs` because the two want opposite things. The web
 * fonts are woff2, split into unicode subsets, and optimised for bytes on a
 * slow connection. A PDF embeds a font by subsetting it itself at render time,
 * so what it needs is the OPPOSITE: one complete, unsplit TTF — woff2 is not a
 * format PDF understands, and a pre-split file would be missing the very
 * glyphs the subsetter is looking for.
 *
 * WHY NOTO SANS, and why this is not interchangeable:
 *
 *   ₦ (U+20A6) is not in WinAnsi, which is the encoding pdfkit's built-in
 *   Helvetica uses. Rendered with a standard font, every price on every
 *   Nigerian invoice becomes a blank box or a wrong glyph. Noto Sans carries
 *   ₦, and it carries Yoruba ẹ (U+1EB9) and ọ (U+1ECD) too, so a business
 *   named "Adeẹ́ Fashion" prints as itself.
 *
 *   See MASTER-PLAN Part 4.3.
 *
 *   node scripts/fetch-pdf-fonts.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = 'apps/api/assets/fonts';

/**
 * An ancient user agent, on purpose: Google Fonts serves woff2 to anything
 * modern, and only a browser that could not have understood woff2 gets TTF.
 *
 * Bare `Mozilla/4.0` specifically. A fuller old string — "MSIE 6.0; Windows NT
 * 5.1" — gets a `/l/font?kit=…` URL with no extension instead of a plain
 * `.ttf`, which is a different serving path and not one worth depending on.
 */
const UA = 'Mozilla/4.0';

const WANTED = [
  { weight: 400, file: 'NotoSans-Regular.ttf' },
  { weight: 600, file: 'NotoSans-SemiBold.ttf' },
];

const css = await fetch(
  'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap',
  { headers: { 'User-Agent': UA } },
).then((r) => {
  if (!r.ok) throw new Error(`Google Fonts returned ${r.status}`);
  return r.text();
});

const blocks = css.split('@font-face').filter((b) => b.includes('src:'));
await mkdir(OUT_DIR, { recursive: true });

for (const { weight, file } of WANTED) {
  const block = blocks.find((b) => b.includes(`font-weight: ${weight}`));
  if (!block) throw new Error(`no @font-face for weight ${weight}`);

  const url = /url\((https:[^)]+\.ttf)\)/.exec(block)?.[1];
  if (!url) {
    throw new Error(
      `weight ${weight} was not served as a .ttf — Google decided the user agent is modern`,
    );
  }

  const bytes = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));

  // sfnt version 0x00010000 is a TrueType outline font. Anything else here
  // means we saved an error page, and the failure would otherwise surface as
  // an unreadable PDF weeks later.
  if (bytes.length < 50_000 || bytes.readUInt32BE(0) !== 0x00010000) {
    throw new Error(`${file} does not look like a TTF (${bytes.length} bytes)`);
  }

  await writeFile(join(OUT_DIR, file), bytes);
  console.log(`${file}  ${(bytes.length / 1024).toFixed(0)} kB`);
}

console.log(`\nWritten to ${OUT_DIR}. Commit them — the API needs them at runtime.`);
