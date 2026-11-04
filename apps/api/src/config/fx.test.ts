/**
 * Foreign exchange in configuration: the planning rate cost telemetry converts
 * with, and the multicurrency kill switch that keeps launch NGN-only (ADR 0033).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

/**
 * The planning FX rate (P1).
 *
 * Cost telemetry's one constant, and the failure everybody would have missed
 * is the silent one: an empty value is not a missing value, so the default
 * never applied and every naira cost became zero.
 */
describe('the planning FX rate', () => {
  const withRate = (value: string | undefined) => {
    const env = { ...BASE } as NodeJS.ProcessEnv;
    if (value === undefined) delete env['PLANNING_FX_NGN_PER_USD'];
    else env['PLANNING_FX_NGN_PER_USD'] = value;
    return () => loadConfig(env);
  };

  it('defaults when the variable is absent', () => {
    expect(withRate(undefined)().planningFxNairaPerUsd).toBe(1_450);
  });

  it('reads a rate somebody set', () => {
    expect(withRate('1620')().planningFxNairaPerUsd).toBe(1_620);
    // Not an integer: a planning rate is a price, and prices have kobo.
    expect(withRate('1620.5')().planningFxNairaPerUsd).toBe(1_620.5);
  });

  /**
   * The quiet one, and the reason this PR exists.
   *
   * `Number(env[...] ?? 1_450)` used `??`, which only catches undefined. A
   * variable written down with nothing after it is an empty STRING, and
   * `Number('')` is 0 - so the default never applied, every AI call recorded
   * a naira cost of zero, and the margin report read as pure profit with
   * nothing anywhere saying otherwise.
   */
  it('refuses a variable set to nothing, rather than reading it as zero', () => {
    expect(withRate('')).toThrow(/PLANNING_FX_NGN_PER_USD/);
  });

  it('refuses zero and negative rates', () => {
    // Zero is the empty-string bug arriving by another road; negative would
    // record negative costs and be accepted all the way to the column.
    expect(withRate('0')).toThrow(/positive/);
    expect(withRate('-1450')).toThrow(/positive/);
  });

  it('refuses a value that is not a number at all', () => {
    /* This one did fail, but in the wrong place: NaN reaches
     * `naira_equivalent_k`, which is a bigint, and PostgreSQL REFUSES a NaN
     * rather than storing one - so the write failed inside a job, one cost
     * row at a time, long after the process started. A deployment typo
     * belongs at boot. */
    expect(withRate('abc')).toThrow(/PLANNING_FX_NGN_PER_USD/);
    expect(withRate('1,450')).toThrow(/PLANNING_FX_NGN_PER_USD/);
  });

  it('refuses an infinite rate, however it was written', () => {
    // `Number('1e400')` is Infinity, which no arithmetic below survives.
    expect(withRate('Infinity')).toThrow(/positive/);
    expect(withRate('1e400')).toThrow(/positive/);
  });
});

/**
 * The multicurrency kill switch (ADR 0033).
 *
 * Rekoda's launch is NGN-only and the FX capability is dark. Darkness that
 * depends on nobody setting a variable is a promise; these are the four
 * assertions that make it a control.
 */
describe('the dark FX capability', () => {
  it('is off when nothing says otherwise', () => {
    expect(loadConfig(BASE).fxMode).toBe('off');
  });

  it('accepts the three modes engineering may use', () => {
    expect(loadConfig({ ...BASE, FX_MODE: 'shadow' }).fxMode).toBe('shadow');
    expect(loadConfig({ ...BASE, FX_MODE: 'sandbox' }).fxMode).toBe('sandbox');
    /* Outside production `live` is loadable, so the state can be built and
     * tested before the gate that opens it exists. */
    expect(loadConfig({ ...BASE, FX_MODE: 'live' }).fxMode).toBe('live');
  });

  it('refuses to START in production on live, rather than warning', () => {
    /* Everything production demands anyway, so the refusal under test is the
     * FX one and not the first missing secret. */
    const PROD = {
      ...BASE,
      NODE_ENV: 'production',
      REKODA_TRUSTED_PROXIES: '172.30.10.10',
      OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
      OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
      OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
      META_APP_SECRET: 'm'.repeat(40),
      META_VERIFY_TOKEN: 'v'.repeat(40),
      REKODA_TRUSTED_WEB: '172.30.10.11',
    } as NodeJS.ProcessEnv;

    /* Off and shadow are fine in production: observing a rate moves no money
     * and exposes nothing. */
    expect(loadConfig(PROD).fxMode).toBe('off');
    expect(loadConfig({ ...PROD, FX_MODE: 'shadow' }).fxMode).toBe('shadow');

    /* The whole point. A deployment that came up with live FX believing it
     * was configured to is the accident the mode exists to prevent, so this
     * is a boot failure and not a log line. */
    expect(() => loadConfig({ ...PROD, FX_MODE: 'live' })).toThrow(/has not been graduated/);
  });

  it('refuses a mode it does not know instead of falling back to off', () => {
    /* Falling back would be the safe VALUE reached by the unsafe ROUTE: a
     * typo would silently become `off`, and the day the gate opens the same
     * typo silently becomes `off` again on a deployment that meant `live`. */
    expect(() => loadConfig({ ...BASE, FX_MODE: 'on' })).toThrow(/FX_MODE must be one of/);
    expect(() => loadConfig({ ...BASE, FX_MODE: 'OFF' })).toThrow(/FX_MODE must be one of/);
  });
});
