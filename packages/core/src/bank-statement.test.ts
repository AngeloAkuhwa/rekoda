import { describe, expect, it } from 'vitest';
import { fingerprintLines, parseBankStatement, parseStatementAmountK } from './bank-statement.js';

/* The shapes real Nigerian banks export. None of them agree, which is the
 * whole reason this parser finds columns by name rather than by position. */

const GTB = `Account Statement
Account Name: MAMA CHIDI STORES
Period: 01-Aug-2026 to 31-Aug-2026

Trans Date,Value Date,Reference,Debits,Credits,Balance,Remarks
03/08/2026,03/08/2026,GT0001,,"150,000.00","150,000.00",TRF FROM ADEBAYO O
05/08/2026,05/08/2026,GT0002,"20,000.00",,"130,000.00",POS PURCHASE SHOPRITE
31/08/2026,31/08/2026,,,,"130,000.00",CLOSING BALANCE
`;

const ZENITH = `Date;Description;Amount;Balance
15-Aug-2026;SALARY PAYMENT;250000.00;250000.00
16-Aug-2026;AIRTIME PURCHASE;-2000.00;248000.00
`;

const ACCESS = `Posting Date,Narration,Withdrawal,Lodgement
20/08/2026,"NIP TRANSFER FROM CHIDI, LAGOS",,"75,500.50"
21/08/2026,"CHARGE: SMS ALERT","52.50",
`;

describe('reading what a bank exported', () => {
  it('skips the preamble and finds the header wherever it starts', () => {
    const parsed = parseBankStatement(GTB);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]).toMatchObject({
      postedOn: '2026-08-03',
      amountK: 15_000_000,
      narration: 'TRF FROM ADEBAYO O',
    });
    /* Money out is negative however the bank spelled it. */
    expect(parsed.lines[1]).toMatchObject({ postedOn: '2026-08-05', amountK: -2_000_000 });
  });

  /* A closing-balance row carries a date and a balance but no movement.
   * Importing it would invent a transaction the size of the account. */
  it('drops a row that reports a balance rather than a movement', () => {
    const parsed = parseBankStatement(GTB);
    if (!parsed.ok) throw new Error('expected a parse');
    expect(parsed.skipped).toContainEqual({ row: 8, why: 'no_amount' });
  });

  it('reads a semicolon file with one signed amount column', () => {
    const parsed = parseBankStatement(ZENITH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lines.map((l) => l.amountK)).toEqual([25_000_000, -200_000]);
    /* A spelled month settles the order without any inference. */
    expect(parsed.lines[0]!.postedOn).toBe('2026-08-15');
  });

  /**
   * The comma inside a narration is the reason rows are split with quotes
   * honoured. A naive split would shift every later column, so the amount
   * would be read out of the wrong cell and the import would be wrong in a
   * way that still looked like money.
   */
  it('keeps a narration that contains a comma in one piece', () => {
    const parsed = parseBankStatement(ACCESS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.lines[0]).toMatchObject({
      narration: 'NIP TRANSFER FROM CHIDI, LAGOS',
      amountK: 7_550_050,
    });
    expect(parsed.lines[1]!.amountK).toBe(-5_250);
  });

  it('carries the bank reference when there is one, and null when there is not', () => {
    const gtb = parseBankStatement(GTB);
    if (!gtb.ok) throw new Error('expected a parse');
    expect(gtb.lines[0]!.bankRef).toBe('GT0001');

    const zenith = parseBankStatement(ZENITH);
    if (!zenith.ok) throw new Error('expected a parse');
    expect(zenith.lines[0]!.bankRef).toBeNull();
  });
});

describe('which number is the day', () => {
  /* One row above the twelfth settles the whole file. */
  it('infers day-first from any row that could only be day-first', () => {
    const parsed = parseBankStatement(
      'Date,Description,Amount\n03/04/2026,A,100.00\n25/04/2026,B,200.00\n',
    );
    if (!parsed.ok) throw new Error('expected a parse');
    expect(parsed.dateOrder).toBe('day_first');
    expect(parsed.lines[0]!.postedOn).toBe('2026-04-03');
  });

  it('infers month-first the same way, from the other side', () => {
    const parsed = parseBankStatement(
      'Date,Description,Amount\n04/03/2026,A,100.00\n04/25/2026,B,200.00\n',
    );
    if (!parsed.ok) throw new Error('expected a parse');
    expect(parsed.dateOrder).toBe('month_first');
    /* 04/03 read month first is the third of April, which is the whole point:
     * the same eight characters mean a different month either way. */
    expect(parsed.lines[0]!.postedOn).toBe('2026-04-03');
  });

  /**
   * A file that proves both is not a date format anybody can read, and
   * guessing would move money into the wrong months silently. Refused whole.
   */
  it('refuses a file that claims both orders', () => {
    const parsed = parseBankStatement(
      'Date,Description,Amount\n25/04/2026,A,100.00\n04/25/2026,B,200.00\n',
    );
    expect(parsed).toEqual({ ok: false, reason: 'mixed_date_order' });
  });

  /* Nigerian order when nothing can settle it, and said out loud rather than
   * decided quietly. */
  it('assumes Nigerian order when every date could be read either way, and says so', () => {
    const parsed = parseBankStatement('Date,Description,Amount\n03/04/2026,A,100.00\n');
    if (!parsed.ok) throw new Error('expected a parse');
    expect(parsed.dateOrder).toBe('ambiguous');
    expect(parsed.lines[0]!.postedOn).toBe('2026-04-03');
  });

  it('reads ISO dates without inferring anything', () => {
    const parsed = parseBankStatement('Date,Description,Amount\n2026-04-03,A,100.00\n');
    if (!parsed.ok) throw new Error('expected a parse');
    expect(parsed.lines[0]!.postedOn).toBe('2026-04-03');
  });

  it('drops a day that does not exist rather than rolling it into the next month', () => {
    const parsed = parseBankStatement(
      'Date,Description,Amount\n31/02/2026,A,100.00\n01/03/2026,B,200.00\n',
    );
    if (!parsed.ok) throw new Error('expected a parse');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.skipped).toContainEqual({ row: 2, why: 'no_date' });
  });
});

describe('refusing a file rather than importing nonsense', () => {
  it.each([
    ['', 'empty'],
    ['just some prose about nothing\n', 'no_header'],
    ['Description,Amount\nA,100.00\n', 'no_header'],
    ['Date,Description\n03/08/2026,A\n', 'no_amount_column'],
    ['Date,Description,Amount\n', 'no_rows'],
  ])('refuses %j with %s', (csv, reason) => {
    expect(parseBankStatement(csv)).toEqual({ ok: false, reason });
  });
});

describe('money as a statement prints it', () => {
  it.each([
    ['150,000.00', 15_000_000],
    ['₦2,500.50', 250_050],
    ['1000', 100_000],
    ['(450.00)', -45_000],
    ['-450.00', -45_000],
    ['450.00 DR', -45_000],
    ['450.00 CR', 45_000],
    ['0.05', 5],
  ])('reads %j as %i kobo', (text, kobo) => {
    expect(parseStatementAmountK(text)).toBe(kobo);
  });

  /**
   * Shorthand is refused on purpose. `parseAmountText` accepts "50k" because
   * a merchant speaks it; a bank statement never does, and accepting it here
   * would let a corrupted cell parse as a plausible figure.
   */
  it.each(['', '   ', 'abc', '50k', '1.234', '12.3.4', '--5'])('refuses %j', (text) => {
    expect(parseStatementAmountK(text)).toBeNull();
  });
});

describe('not importing the same line twice', () => {
  const parse = (csv: string) => {
    const p = parseBankStatement(csv);
    if (!p.ok) throw new Error(`expected a parse, got ${p.reason}`);
    return fingerprintLines(p.lines);
  };

  it('gives the same file the same keys however often it is uploaded', () => {
    const once = parse(ACCESS).map((l) => l.fingerprint);
    const twice = parse(ACCESS).map((l) => l.fingerprint);
    expect(twice).toEqual(once);
  });

  it('tells two different lines apart', () => {
    const keys = parse(ACCESS).map((l) => l.fingerprint);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The case a naive key loses. Two identical charges on the same day are two
   * real charges, and collapsing them takes money off the merchant's
   * statement that their bank says is gone.
   */
  it('keeps both of two identical charges on the same day', () => {
    const keys = parse(
      'Date,Description,Amount\n' +
        '20/08/2026,SMS ALERT CHARGE,-52.50\n' +
        '20/08/2026,SMS ALERT CHARGE,-52.50\n',
    ).map((l) => l.fingerprint);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  /* And re-uploading a file containing twins still matches both, rather than
   * matching one and importing the other again. */
  it('matches both twins on a second upload', () => {
    const csv =
      'Date,Description,Amount\n' +
      '20/08/2026,SMS ALERT CHARGE,-52.50\n' +
      '20/08/2026,SMS ALERT CHARGE,-52.50\n';
    expect(parse(csv).map((l) => l.fingerprint)).toEqual(parse(csv).map((l) => l.fingerprint));
  });

  /* A narration ending in a digit must not run into the field beside it. */
  it('does not confuse two lines whose fields merely concatenate the same', () => {
    const keys = parse(
      'Date,Description,Amount\n' +
        '20/08/2026,"PAYMENT 1",-100.00\n' +
        '20/08/2026,"PAYMENT",-100.00\n',
    ).map((l) => l.fingerprint);
    expect(new Set(keys).size).toBe(2);
  });
});
