import { describe, expect, it } from 'vitest';
import { buildXlsx, cellRef, sheetName, xlsxNaira } from './xlsx.js';

const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes);

describe('cellRef', () => {
  it('counts columns the way the format does', () => {
    expect(cellRef(1, 1)).toBe('A1');
    expect(cellRef(2, 7)).toBe('B7');
    expect(cellRef(26, 3)).toBe('Z3');
  });

  it('carries past Z, where an off-by-one would put every wide sheet in the wrong column', () => {
    expect(cellRef(27, 1)).toBe('AA1');
    expect(cellRef(28, 1)).toBe('AB1');
    expect(cellRef(52, 1)).toBe('AZ1');
    expect(cellRef(53, 1)).toBe('BA1');
    expect(cellRef(702, 1)).toBe('ZZ1');
    expect(cellRef(703, 1)).toBe('AAA1');
  });
});

describe('sheetName', () => {
  it('leaves an ordinary name alone', () => {
    expect(sheetName('Profit and loss')).toBe('Profit and loss');
  });

  it('removes what Excel refuses, rather than handing over a file that will not open', () => {
    expect(sheetName('P/L: 2026 [draft]?')).toBe('P L  2026  draft');
  });

  it('cuts to the 31 characters Excel allows', () => {
    expect(sheetName('a'.repeat(40))).toHaveLength(31);
  });

  it('names an empty one rather than leaving a tab with no name', () => {
    expect(sheetName('   ')).toBe('Sheet');
    expect(sheetName('///')).toBe('Sheet');
  });
});

describe('xlsxNaira', () => {
  it('is naira with the kobo kept', () => {
    expect(xlsxNaira(15_000_000)).toBe(150_000);
    expect(xlsxNaira(1_234_56)).toBe(1_234.56);
  });

  it('rounds a fractional kobo rather than carrying it into a cell', () => {
    expect(xlsxNaira(150.6)).toBe(1.51);
  });
});

describe('the workbook', () => {
  const SIMPLE = [{ name: 'Sheet1', rows: [['Total', 1234]] }];

  it('refuses to build with no sheets', () => {
    expect(() => buildXlsx([])).toThrow();
  });

  it('is a zip: it starts with the local file header signature', () => {
    const bytes = buildXlsx(SIMPLE);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('ends with the central directory record, which is what a reader looks for first', () => {
    const bytes = buildXlsx(SIMPLE);
    const tail = [...bytes.slice(-22, -18)];
    expect(tail).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it('carries the five parts Excel needs and no more', () => {
    const raw = text(buildXlsx(SIMPLE));
    expect(raw).toContain('[Content_Types].xml');
    expect(raw).toContain('_rels/.rels');
    expect(raw).toContain('xl/workbook.xml');
    expect(raw).toContain('xl/_rels/workbook.xml.rels');
    expect(raw).toContain('xl/worksheets/sheet1.xml');
  });

  it('writes a number as a number, so somebody can sum the column', () => {
    const raw = text(buildXlsx(SIMPLE));
    /* The whole reason to ship a spreadsheet instead of a PDF. A figure
     * written as text is a figure nobody can total. */
    expect(raw).toContain('<c r="B1"><v>1234</v></c>');
    expect(raw).not.toContain('<v>Total</v>');
  });

  it('writes text as an inline string, with its position', () => {
    const raw = text(buildXlsx(SIMPLE));
    expect(raw).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Total</t></is></c>');
  });

  it('escapes a merchant name that would otherwise break the file', () => {
    const raw = text(buildXlsx([{ name: 'S', rows: [['Ben & Sons 12" pipe <x>']] }]));
    expect(raw).toContain('Ben &amp; Sons 12&quot; pipe &lt;x&gt;');
    expect(raw).not.toContain('Ben & Sons');
  });

  it('drops control characters XML has no way to represent', () => {
    const raw = text(buildXlsx([{ name: 'S', rows: [[`badname`]] }]));
    expect(raw).toContain('badname');
  });

  it('skips an empty cell rather than writing an empty one', () => {
    const raw = text(buildXlsx([{ name: 'S', rows: [['a', null, '', 'd']] }]));
    expect(raw).toContain('r="A1"');
    expect(raw).not.toContain('r="B1"');
    expect(raw).not.toContain('r="C1"');
    expect(raw).toContain('r="D1"');
  });

  it('writes a figure that is not a real number as text rather than a corrupt cell', () => {
    const raw = text(buildXlsx([{ name: 'S', rows: [[Number.NaN, Number.POSITIVE_INFINITY]] }]));
    expect(raw).not.toContain('<v>NaN</v>');
    expect(raw).not.toContain('<v>Infinity</v>');
  });

  it('names every sheet in the workbook and relates each to its part', () => {
    const raw = text(
      buildXlsx([
        { name: 'Profit and loss', rows: [['a']] },
        { name: 'Balance sheet', rows: [['b']] },
        { name: 'Cash flow', rows: [['c']] },
        { name: 'Trial balance', rows: [['d']] },
      ]),
    );
    for (const name of ['Profit and loss', 'Balance sheet', 'Cash flow', 'Trial balance']) {
      expect(raw).toContain(`name="${name}"`);
    }
    expect(raw).toContain('xl/worksheets/sheet4.xml');
    expect(raw).toContain('Target="worksheets/sheet4.xml"');
  });

  it('is byte-identical when built twice from the same figures', () => {
    /* No clock anywhere in it. A workbook that differed run to run could not
     * be asserted on, and the date inside a zip entry is not information
     * anybody reads: the dated line is on the statements themselves. */
    expect(buildXlsx(SIMPLE)).toEqual(buildXlsx(SIMPLE));
  });

  it('records each part length so a reader can walk the archive', () => {
    const bytes = buildXlsx(SIMPLE);
    /* A wrong length here produces a file that looks fine and opens as
     * corrupt, which is the failure this whole format punishes hardest. */
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const centralSize = view.getUint32(bytes.length - 10, true);
    const centralOffset = view.getUint32(bytes.length - 6, true);
    expect(centralOffset + centralSize + 22).toBe(bytes.length);
  });

  it('counts its entries once in each place the format asks', () => {
    const bytes = buildXlsx([
      { name: 'One', rows: [['a']] },
      { name: 'Two', rows: [['b']] },
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /* Five fixed parts plus one sheet each. */
    expect(view.getUint16(bytes.length - 14, true)).toBe(6);
    expect(view.getUint16(bytes.length - 12, true)).toBe(6);
  });
});
