import { describe, expect, it } from 'vitest';
import { safeReturnPath, startPath } from './return-path';

describe('the path sign-in returns to', () => {
  it('accepts only the pages it names, exactly as written', () => {
    expect(safeReturnPath('/app')).toBe('/app');
    expect(safeReturnPath('/app/payments')).toBe('/app/payments');
  });

  it('refuses a dashboard GET that does something, such as a metered download', () => {
    for (const value of [
      '/app/export/statements',
      '/app/export/invoices',
      '/app/export/data',
      '/app/product-photo/00000000-0000-4000-8000-000000000000',
      '/app/invoices',
    ]) {
      expect(safeReturnPath(value), value).toBeNull();
    }
  });

  it('refuses anything that could leave the dashboard, or the site', () => {
    for (const value of [
      undefined,
      null,
      42,
      ['/app/payments'],
      { toString: () => '/app/payments' },
      new Blob(['/app/payments']),
      '',
      '/',
      'app/payments',
      '/start',
      '/application',
      '/app/',
      '/app/payments/',
      '/app//payments',
      '//evil.example.test',
      '//evil.example.test/app',
      '/\\evil.example.test',
      '/app\\..\\..\\evil',
      '/app/../start',
      '/app/%2e%2e/start',
      '/app/payments?x=1',
      '/app/payments#top',
      'https://evil.example.test/app',
      'javascript:alert(1)',
      '/app/pay ments',
      ' /app/payments',
      '/app/payments ',
      '/app\n',
      '/app/payments\r\n',
      '/app\t',
      '/app/payments\u0000',
      '/app ',
      '/APP',
      '/App/Payments',
      '/app/paymentK', // KELVIN SIGN, not a K
      '/app/ｐａｙｍｅｎｔｓ', // full-width letters
    ]) {
      expect(safeReturnPath(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('sends a merchant to /start, carrying only a safe destination', () => {
    expect(startPath('/app/payments')).toBe('/start?next=%2Fapp%2Fpayments');
    expect(startPath()).toBe('/start');
    expect(startPath('//evil.example.test')).toBe('/start');
    expect(startPath('/app/export/statements')).toBe('/start');
  });
});
