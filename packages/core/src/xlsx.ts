/**
 * A spreadsheet, written by hand.
 *
 * `docs/pricing-model.md` sells "PDF/Excel reports" on every paid plan, and
 * the CSV exports are what most tools mean by that. What CSV genuinely cannot
 * do is the thing an accountant actually asks for: the four statements in ONE
 * file, one sheet each, with the figures still numbers. Four separate CSVs is
 * four separate files to reconcile by hand.
 *
 * ── why this is not a dependency ────────────────────────────────────────────
 * The libraries that do this are large, and the subset needed here is small:
 * a zip container and two XML parts per sheet. More to the point, every one of
 * them is a parser as well as a writer, and a parser is attack surface for a
 * feature that only ever writes.
 *
 * ── why nothing is compressed ───────────────────────────────────────────────
 * Zip entries are STORED rather than deflated, which means no `node:zlib` and
 * therefore no node built-in anywhere in this file. That keeps it importable
 * from the same places the rest of core is, and costs a few kilobytes on a
 * document that is a few kilobytes. Excel, LibreOffice and Google Sheets all
 * read stored entries; the format has allowed them since it was PKZIP.
 */

export type CellValue = string | number | null;

export interface Sheet {
  /** Tab name. Excel forbids : \ / ? * [ ] and more than 31 characters. */
  readonly name: string;
  readonly rows: ReadonlyArray<ReadonlyArray<CellValue>>;
}

/* ── xml ──────────────────────────────────────────────────────────────────── */

/**
 * Escape for XML text and attributes both.
 *
 * A merchant's product is called whatever they call it, including `Ben & Sons`
 * and `12" pipe`. Unescaped, the first breaks the file and the second breaks
 * an attribute, and a workbook Excel refuses to open is indistinguishable to
 * them from a product that lost their data.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strip what the XML 1.0 spec has no way to represent.
 *
 * Control characters are not escapable: `&#x1;` is as illegal as the raw byte.
 * They should never reach here, but a transcript or a pasted product name is
 * merchant-supplied text, and dropping one character beats handing somebody a
 * file that will not open.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** `A1`, `B7`, `AA3`. Columns are 1-based, as the format counts them. */
export function cellRef(column: number, row: number): string {
  let name = '';
  let n = column;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return `${name}${row}`;
}

/**
 * Excel's sheet-name rules, applied rather than assumed.
 *
 * A name it rejects makes the whole workbook unopenable, so the invalid
 * characters go and the length is cut. `Sheet` for an empty result, because a
 * tab with no name is also refused.
 */
export function sheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim();
  return cleaned.length === 0 ? 'Sheet' : cleaned.slice(0, 31);
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const row = rowIndex + 1;
      const written = cells
        .map((value, columnIndex) => {
          if (value === null || value === '') return '';
          const ref = cellRef(columnIndex + 1, row);
          /**
           * Numbers as numbers, and only when they really are.
           *
           * A figure written as text is a figure nobody can sum, which is the
           * entire reason somebody asked for a spreadsheet instead of a PDF.
           * `Infinity` and `NaN` are not writable as numbers and would produce
           * a corrupt cell, so they fall through to text.
           */
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          const text = String(value).replace(ILLEGAL, '');
          /* `xml:space="preserve"` so a leading space in a merchant's product
           * name survives the round trip rather than being quietly trimmed. */
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${row}">${written}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

/* ── zip ──────────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  bytes: Uint8Array;
  crc: number;
  offset: number;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * A zip with every entry STORED.
 *
 * Timestamps are written as a fixed 1980-01-01, the epoch of the MS-DOS date
 * field the format uses. Deliberate: a workbook built twice from the same
 * figures should be byte-identical, which is what lets a test assert the
 * bytes at all, and the date on a file inside a zip is not information anybody
 * reads. The dated one is on the statements themselves.
 */
function zip(files: ReadonlyArray<{ name: string; text: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const entries: Entry[] = [];
  const local: number[] = [];

  for (const file of files) {
    const bytes = encoder.encode(file.text);
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(bytes);
    entries.push({ name: file.name, bytes, crc, offset: local.length });

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0x0800), // UTF-8 names
      ...u16(0), // stored
      ...u16(0), // time
      ...u16(0x0021), // date: 1980-01-01
      ...u32(crc),
      ...u32(bytes.length),
      ...u32(bytes.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...bytes,
    );
  }

  const central: number[] = [];
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0x0800),
      ...u16(0),
      ...u16(0),
      ...u16(0x0021),
      ...u32(entry.crc),
      ...u32(entry.bytes.length),
      ...u32(entry.bytes.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(entry.offset),
      ...nameBytes,
    );
  }

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ];

  return Uint8Array.from([...local, ...central, ...end]);
}

/* ── the workbook ─────────────────────────────────────────────────────────── */

/**
 * Build an `.xlsx` from sheets of plain values.
 *
 * The minimum set of parts Excel will open: a content-type map, the root
 * relationship, the workbook, its relationships, and one worksheet each. No
 * styles part, so every cell is General format — a naira column shows as a
 * number, which is what a spreadsheet is for. Formatting it as currency would
 * mean shipping a styles part to assert a symbol the merchant can apply in one
 * click and that we would get wrong for anybody trading in dollars.
 */
export function buildXlsx(sheets: ReadonlyArray<Sheet>): Uint8Array {
  if (sheets.length === 0) throw new Error('a workbook needs at least one sheet');

  const named = sheets.map((sheet, i) => ({ ...sheet, name: sheetName(sheet.name), index: i + 1 }));

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    named
      .map(
        (s) =>
          `<Override PartName="/xl/worksheets/sheet${s.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    `</Types>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    named
      .map((s) => `<sheet name="${xml(s.name)}" sheetId="${s.index}" r:id="rId${s.index}"/>`)
      .join('') +
    `</sheets></workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    named
      .map(
        (s) =>
          `<Relationship Id="rId${s.index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.index}.xml"/>`,
      )
      .join('') +
    `</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', text: contentTypes },
    { name: '_rels/.rels', text: rootRels },
    { name: 'xl/workbook.xml', text: workbook },
    { name: 'xl/_rels/workbook.xml.rels', text: workbookRels },
    ...named.map((s) => ({
      name: `xl/worksheets/sheet${s.index}.xml`,
      text: sheetXml(s),
    })),
  ]);
}

/** Kobo as a spreadsheet number: naira with two decimals, summable. */
export function xlsxNaira(kobo: number): number {
  return Math.round(kobo) / 100;
}
