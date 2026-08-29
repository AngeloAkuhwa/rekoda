/**
 * The production gate on company facts (remediation R8).
 *
 * A legal page that renders "not set yet" badges must be unreachable in
 * production: the gate refuses to start the server. These tests pin the
 * three behaviours that matter — it fires only at production server start,
 * it treats blank the same as absent, and its error names every missing
 * variable so the operator fixes the deployment once, not five times.
 */
import { describe, expect, it } from 'vitest';
import {
  MANDATORY_LEGAL_VARS,
  assertLegalIdentityConfigured,
  missingLegalVars,
} from '../../legal-gate.mjs';
import { LEGAL } from './legal';

const COMPLETE: Record<string, string> = {
  NEXT_PUBLIC_LEGAL_ENTITY: 'Rekoda Technologies Ltd',
  NEXT_PUBLIC_LEGAL_RC_NUMBER: 'RC 1234567',
  NEXT_PUBLIC_LEGAL_ADDRESS: '1 Example Close, Lagos',
  NEXT_PUBLIC_PRIVACY_EMAIL: 'privacy@example.com',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.com',
};

describe('missingLegalVars', () => {
  it('is empty when every mandatory value is present', () => {
    expect(missingLegalVars(COMPLETE)).toEqual([]);
  });

  it('reports every absent variable, not just the first', () => {
    expect(missingLegalVars({})).toEqual([...MANDATORY_LEGAL_VARS]);
  });

  it('treats whitespace as unset: it renders the same badge absence does', () => {
    const env = { ...COMPLETE, NEXT_PUBLIC_LEGAL_RC_NUMBER: '   ' };
    expect(missingLegalVars(env)).toEqual(['NEXT_PUBLIC_LEGAL_RC_NUMBER']);
  });

  it('does not demand the NDPR auditor, whose filing has its own honest copy', () => {
    expect(MANDATORY_LEGAL_VARS).not.toContain('NEXT_PUBLIC_NDPR_AUDITOR');
  });
});

describe('assertLegalIdentityConfigured', () => {
  it('refuses to start a production server with missing facts, naming them all', () => {
    const env = { ...COMPLETE };
    delete env.NEXT_PUBLIC_LEGAL_ENTITY;
    delete env.NEXT_PUBLIC_PRIVACY_EMAIL;
    expect(() => assertLegalIdentityConfigured('phase-production-server', env)).toThrowError(
      /NEXT_PUBLIC_LEGAL_ENTITY, NEXT_PUBLIC_PRIVACY_EMAIL are not set/,
    );
  });

  it('starts cleanly when everything is set', () => {
    expect(() => assertLegalIdentityConfigured('phase-production-server', COMPLETE)).not.toThrow();
  });

  it('lets `next build` proceed without the values (CI never holds them)', () => {
    expect(() => assertLegalIdentityConfigured('phase-production-build', {})).not.toThrow();
  });

  it('leaves development alone: badges are the honest rendering there', () => {
    expect(() => assertLegalIdentityConfigured('phase-development-server', {})).not.toThrow();
  });

  it('lets the e2e harness serve the production build against badges', () => {
    /* playwright.config.ts is the only place that may set this: the suite's
     * whole point is serving the production build, and CI holds no facts. */
    expect(() =>
      assertLegalIdentityConfigured('phase-production-server', {
        REKODA_E2E_PLACEHOLDER_LEGAL: '1',
      }),
    ).not.toThrow();
  });

  it('accepts no value for the e2e escape hatch except the literal 1', () => {
    for (const value of ['true', 'yes', '0', '']) {
      expect(() =>
        assertLegalIdentityConfigured('phase-production-server', {
          REKODA_E2E_PLACEHOLDER_LEGAL: value,
        }),
      ).toThrowError(/refusing to serve/);
    }
  });
});

describe('the gate and the page agree on what a fact is', () => {
  it('guards every LEGAL fact except the deliberately optional auditor', () => {
    /* If someone adds a company fact to LEGAL and forgets the gate, the new
     * fact ships as a production badge. This assertion is the reminder:
     * LEGAL keys map 1:1 onto mandatory env vars, auditor excepted. */
    const optional = new Set(['ndprAuditor']);
    const guarded = Object.keys(LEGAL).filter((key) => !optional.has(key));
    expect(MANDATORY_LEGAL_VARS).toHaveLength(guarded.length);
  });
});
