import { describe, expect, it } from 'vitest';
import { safeReturnPath, startPath } from './return-path';

describe('the path sign-in returns to', () => {
  it('accepts a dashboard path, spelled plainly', () => {
    expect(safeReturnPath('/app')).toBe('/app');
    expect(safeReturnPath('/app/payments')).toBe('/app/payments');
    expect(safeReturnPath('/app/export/sales-register')).toBe('/app/export/sales-register');
  });

  it('refuses anything that could leave the dashboard, or the site', () => {
    for (const value of [
      undefined,
      null,
      42,
      ['/app/payments'],
      '',
      '/',
      'app/payments',
      '/start',
      '/application',
      '/app/',
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
    ]) {
      expect(safeReturnPath(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('sends a merchant to /start, carrying only a safe destination', () => {
    expect(startPath('/app/payments')).toBe('/start?next=%2Fapp%2Fpayments');
    expect(startPath()).toBe('/start');
    expect(startPath('//evil.example.test')).toBe('/start');
  });
});
