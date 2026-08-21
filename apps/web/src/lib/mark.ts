/**
 * The Rekoda mark, as one path.
 *
 * Two files draw it: `app/icon.svg`, which browsers use for the tab, and
 * `app/apple-icon.tsx`, which iOS uses on a home screen. They exist
 * separately because Apple's icon has to be an opaque square PNG and a
 * favicon is better as vector, but they must be the same drawing. Keeping the
 * geometry here, and asserting in `og.test.tsx` that the static file still
 * contains it, is what stops one of them quietly becoming a different logo.
 */
export const MARK_VIEWBOX = '0 0 64 64';
export const MARK_PATH =
  'M22 46V18h11.2c5.6 0 9.3 3.2 9.3 8.2 0 3.7-2 6.4-5.3 7.5L44 46h-7.4l-5.7-11h-2.3v11H22zm6.6-16.3h4.1c2.4 0 3.9-1.3 3.9-3.4s-1.5-3.4-3.9-3.4h-4.1v6.8z';
/** The one green. Also `--rk-accent`, but a generated image has no CSS. */
export const MARK_GREEN = '#0f766e';
export const MARK_PAPER = '#fcfcfb';
