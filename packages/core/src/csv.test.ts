/**
 * The export a merchant takes with them when they leave.
 *
 * Most of these assertions are about the two ways a CSV goes wrong: quoting,
 * which makes it unreadable, and formula injection, which makes it dangerous.
 * The second is the one worth being loud about — every field in this file
 * came from something somebody typed at us, and the file is opened by an
 * accountant who trusts it.
 */
import { describe, expect, it } from 'vitest';
import { csvDate, csvField, csvKobo, toCsv } from './csv.js';

describe('escaping a field', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('wig')).toBe('wig');
    expect(csvField(42)).toBe('42');
  });

  it('writes nothing for nothing', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField('')).toBe('');
  });

  it('quotes a field containing a comma, a quote or a newline', () => {
    expect(csvField('wigs, bags')).toBe('"wigs, bags"');
    expect(csvField('the "big" one')).toBe('"the ""big"" one"');
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
  });

  /* Wrapping unconditionally would be simpler and would also make every
   * number in the file a string to some importers. */
  it('does not quote what does not need it', () => {
    expect(csvField('150000.00')).toBe('150000.00');
  });
});

describe('defusing a formula', () => {
  /**
   * Excel, LibreOffice and Google Sheets all treat a leading =, +, - or @ as
   * a FORMULA. A customer named `=cmd|'/c calc'!A1` is remote code execution
   * waiting for somebody to open an attachment.
   */
  it('neutralises every leader a spreadsheet would execute', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+44 800')).toBe("'+44 800");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    /* No comma, no double quote, no newline in this one, so it is defused
     * without being wrapped. Apostrophes need no escaping in CSV. */
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it('quotes the defused value when it also needs quoting', () => {
    expect(csvField('=A1,B1')).toBe(`"'=A1,B1"`);
  });

  /* Prefixing rather than stripping, so a legitimate negative number keeps
   * its sign and its meaning. */
  it('keeps a negative number readable rather than mangling it', () => {
    expect(csvField('-500')).toBe("'-500");
  });

  it('leaves a leader in the MIDDLE alone: only the first character runs', () => {
    expect(csvField('3=3')).toBe('3=3');
  });
});

describe('a whole file', () => {
  it('writes a header and rows, CRLF separated as RFC 4180 says', () => {
    const csv = toCsv(
      ['Number', 'Amount'],
      [
        ['INV-2026-000001', '150000.00'],
        ['INV-2026-000002', '80000.00'],
      ],
    );
    expect(csv).toBe('Number,Amount\r\nINV-2026-000001,150000.00\r\nINV-2026-000002,80000.00\r\n');
  });

  it('writes a header alone when there is nothing to export', () => {
    expect(toCsv(['Number'], [])).toBe('Number\r\n');
  });

  it('defuses a header too, since headers are data somewhere', () => {
    expect(toCsv(['=evil'], [])).toBe("'=evil\r\n");
  });
});

describe('money in a file a spreadsheet will sum', () => {
  /**
   * Never `formatKobo`. `₦150,000` is four things a spreadsheet reads as
   * text, and an export whose money column will not add up is an export
   * nobody can do anything with.
   */
  it('writes a plain decimal, no symbol and no separators', () => {
    expect(csvKobo(15_000_000)).toBe('150000.00');
    expect(csvKobo(5)).toBe('0.05');
    expect(csvKobo(0)).toBe('0.00');
  });

  it('keeps the sign on a negative, and the sign only', () => {
    expect(csvKobo(-2_050)).toBe('-20.50');
  });

  it('never loses a kobo to floating point', () => {
    expect(csvKobo(1_234_567)).toBe('12345.67');
    expect(csvKobo(99)).toBe('0.99');
  });
});

describe('dates in a file', () => {
  it('writes the LAGOS calendar date, not the UTC one', () => {
    // 23:30 UTC is 00:30 the next day in Lagos, and the merchant's books say
    // so. This is the hour the two disagree.
    expect(csvDate(new Date('2026-08-19T23:30:00Z'))).toBe('2026-08-20');
    expect(csvDate(new Date('2026-08-19T09:00:00Z'))).toBe('2026-08-19');
  });

  it('writes nothing for no date', () => {
    expect(csvDate(null)).toBe('');
    expect(csvDate(undefined)).toBe('');
  });
});
