import { formatKobo } from '@rekoda/core';

interface Month {
  period: string; // YYYY-MM
  inK: number;
  outK: number;
}

/**
 * Money in vs money out, by Lagos month — a server-rendered SVG.
 *
 * Hand-rolled rather than a chart library, deliberately: this page is a
 * React Server Component, a charting dependency would force a client island
 * plus ~100kB of generic-looking JS, and an overview chart of twelve bars
 * does not need either. The marks follow the dataviz method: thin bars with
 * rounded DATA ends anchored to the baseline, a 2px surface gap inside each
 * pair, a legend (two series always get one), selective direct labels (the
 * latest month only — a number on every bar is noise), text in text tokens
 * never series colour, and a native <title> per pair so hover and screen
 * readers both get the figures. Series colours are the validated
 * --rk-chart-* tokens; the swap for dark mode happens in CSS, not here.
 */
export function CashflowChart({ months }: { months: Month[] }) {
  const W = 560;
  const PLOT_H = 168;
  const LABEL_H = 26;
  const MARGIN = 8;
  const BAR = 22;
  const PAIR_GAP = 2;
  const RADIUS = 4;

  const maxK = Math.max(1, ...months.map((m) => Math.max(m.inK, m.outK)));
  const groupW = (W - MARGIN * 2) / months.length;
  const latest = months[months.length - 1];

  const monthLabel = (period: string) =>
    new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-NG', {
      month: 'short',
      timeZone: 'UTC',
    });

  /** A bar with rounded top corners only — the data end gets the radius, the
   * baseline end stays square, so every bar visibly grows from zero. */
  const bar = (x: number, heightK: number, cls: string, key: string) => {
    const h = Math.round((heightK / maxK) * (PLOT_H - RADIUS)) + (heightK > 0 ? RADIUS : 0);
    if (h <= 0) return null;
    const y = PLOT_H - h;
    const r = Math.min(RADIUS, h);
    const d =
      `M ${x} ${PLOT_H} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} ` +
      `L ${x + BAR - r} ${y} Q ${x + BAR} ${y} ${x + BAR} ${y + r} L ${x + BAR} ${PLOT_H} Z`;
    return <path key={key} d={d} className={cls} />;
  };

  return (
    <figure className="rk-cashflow">
      <div className="rk-chart-legend" aria-hidden="true">
        <span>
          <i className="rk-swatch rk-swatch-in" /> Money in
        </span>
        <span>
          <i className="rk-swatch rk-swatch-out" /> Money out
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${PLOT_H + LABEL_H}`}
        role="img"
        aria-label={`Money in and money out for the last ${months.length} months. Latest month: ${formatKobo(latest?.inK ?? 0)} in, ${formatKobo(latest?.outK ?? 0)} out.`}
        className="rk-chart"
      >
        {/* One recessive baseline; the figures live on the bars, not an axis. */}
        <line x1={MARGIN} y1={PLOT_H} x2={W - MARGIN} y2={PLOT_H} className="rk-chart-baseline" />

        {months.map((m, i) => {
          const groupX = MARGIN + i * groupW;
          const pairX = groupX + (groupW - (BAR * 2 + PAIR_GAP)) / 2;
          return (
            <g key={m.period}>
              {/* The whole month column is the hover target, larger than the
                  marks themselves; its title is the tooltip and the AT text. */}
              <rect x={groupX} y={0} width={groupW} height={PLOT_H} fill="transparent">
                <title>
                  {`${monthLabel(m.period)}: ${formatKobo(m.inK)} in, ${formatKobo(m.outK)} out`}
                </title>
              </rect>
              {bar(pairX, m.inK, 'rk-bar-in', `${m.period}-in`)}
              {bar(pairX + BAR + PAIR_GAP, m.outK, 'rk-bar-out', `${m.period}-out`)}
              <text x={groupX + groupW / 2} y={PLOT_H + 18} className="rk-chart-month">
                {monthLabel(m.period)}
              </text>
            </g>
          );
        })}
      </svg>

      {latest ? (
        <figcaption className="rk-chart-latest">
          {monthLabel(latest.period)}: {formatKobo(latest.inK)} in, {formatKobo(latest.outK)} out
        </figcaption>
      ) : null}
    </figure>
  );
}
