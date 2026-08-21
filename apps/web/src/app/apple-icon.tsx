import { ImageResponse } from 'next/og';
import { MARK_GREEN, MARK_PAPER, MARK_PATH, MARK_VIEWBOX } from '@/lib/mark';

/**
 * The icon iOS puts on a home screen (MASTER-PLAN §5.2.5).
 *
 * Its own file because Apple's is opaque and square with no rounding of its
 * own: the system rounds it, and an SVG with a transparent background gets a
 * black card behind it instead. So the rounded corner that `icon.svg` draws
 * is deliberately absent here, and everything inside it is the same drawing.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: MARK_GREEN,
      }}
    >
      {/* The mark itself rather than a letter set in whatever font the
          renderer happens to have. A typed "R" is a different logo at every
          weight, and this one has to match the tab icon exactly. */}
      <svg width={size.width} height={size.height} viewBox={MARK_VIEWBOX}>
        <path d={MARK_PATH} fill={MARK_PAPER} />
      </svg>
    </div>,
    size,
  );
}
