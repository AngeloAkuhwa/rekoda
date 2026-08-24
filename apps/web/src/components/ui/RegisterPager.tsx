/**
 * Paging for a register (fix-plan 5, H2b).
 *
 * Plain anchors, server-rendered, like the public shop's pager and for the
 * same reason: a page of a register is a place a link can point at. "Newer"
 * and "Older" rather than numbers, because a ledger is walked backwards in
 * time and a merchant thinks in that direction, not in page arithmetic.
 * Renders nothing when everything fits on one page, so most merchants never
 * see it.
 */
export function RegisterPager({
  page,
  count,
  pageSize,
  basePath,
  label,
}: {
  page: number;
  count: number;
  pageSize: number;
  basePath: string;
  /** What a page holds, for the middle sentence: "invoices", "entries". */
  label: string;
}) {
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  if (pageCount <= 1) return null;
  const clamped = Math.min(Math.max(1, page), pageCount);
  return (
    <nav className="rk-shop-pager" aria-label={`Pages of ${label}`}>
      {clamped > 1 ? (
        <a className="rk-btn" href={clamped === 2 ? basePath : `${basePath}?page=${clamped - 1}`}>
          Newer
        </a>
      ) : null}
      <span className="rk-fineprint">
        Page {clamped} of {pageCount} · {count} {label}
      </span>
      {clamped < pageCount ? (
        <a className="rk-btn" href={`${basePath}?page=${clamped + 1}`}>
          Older
        </a>
      ) : null}
    </nav>
  );
}

/** Anything unparseable is page one: a mangled link should still open. */
export function pageParam(raw: string | string[] | undefined): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(first ?? '1', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}
