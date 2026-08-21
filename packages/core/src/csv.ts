/**
 * Getting the books out, as a file a spreadsheet opens.
 *
 * Export is not a nice-to-have for a bookkeeping product, it is the answer to
 * "what happens to my records if I leave" — the question Nigerian merchants
 * learned to ask the hard way when Kippa shut down with their data inside it.
 * A product that cannot be left is a product that has to be trusted blindly,
 * and asking for that is worse than earning it.
 *
 * Pure and here rather than in a route handler, because the escaping below is
 * the whole file and it deserves tests.
 */

/**
 * The four characters that turn a cell into a program.
 *
 * Excel, LibreOffice and Google Sheets all treat a cell beginning with one of
 * these as a FORMULA. A customer named `=cmd|'/c calc'!A1` is a remote code
 * execution waiting for an accountant to open an attachment, and every field
 * in this export came from something somebody typed at us.
 *
 * Prefixing with an apostrophe is the fix every spreadsheet understands: the
 * cell shows the text and evaluates nothing. Stripping the character instead
 * would silently corrupt a legitimate negative number.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * One field, escaped for CSV (RFC 4180) and defused for spreadsheets.
 *
 * Quotes are doubled and the whole field is wrapped whenever it contains a
 * comma, a quote or a newline. Wrapping unconditionally would be simpler and
 * would also make every number in the file a string to some importers.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  if (raw === '') return '';

  const defused = FORMULA_LEADERS.has(raw[0]!) ? `'${raw}` : raw;
  if (!/[",\n\r]/.test(defused)) return defused;
  return `"${defused.replace(/"/g, '""')}"`;
}

/**
 * A whole file: a header row, then the rows, CRLF-separated.
 *
 * CRLF because RFC 4180 says so and because Excel on Windows is still what
 * most Nigerian accountants open these in.
 */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) lines.push(row.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Kobo as a decimal a spreadsheet will sum.
 *
 * Never `formatKobo`: `₦150,000` is four things a spreadsheet reads as text,
 * and an export whose money column will not add up is an export nobody can
 * do anything with. The naira symbol belongs to the screen, not the file.
 */
export function csvKobo(kobo: number): string {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A Lagos calendar date, ISO, which every spreadsheet parses as a date. */
export function csvDate(at: Date | null | undefined): string {
  if (!at) return '';
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);
}
