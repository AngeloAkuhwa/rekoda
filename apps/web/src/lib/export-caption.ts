/**
 * What an export link may promise.
 *
 * The CSV routes stop at EXPORT_ROWS (the API's deliberate ceiling, chosen
 * as roughly a decade of a busy shop), and a link that says "all" past that
 * point is a promise the file does not keep. The caption tells the truth the
 * page already knows: the register's own whole-business count.
 */
export const EXPORT_ROWS = 10_000;

export function exportCaption(noun: string, count: number): string {
  return count > EXPORT_ROWS
    ? `Download the latest ${EXPORT_ROWS.toLocaleString('en-NG')} of ${count.toLocaleString('en-NG')} ${noun} (CSV)`
    : `Download all ${noun} as a spreadsheet (CSV)`;
}
