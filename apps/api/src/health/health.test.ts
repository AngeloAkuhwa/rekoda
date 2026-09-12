/**
 * When /health may say `ok` (G-01). The container health checks, `up --wait`
 * and the deploy runbook all read this one word, so it must mean "the schema
 * this build needs is present", in both directions of a deploy.
 */
import { describe, expect, it } from 'vitest';
import { bundledMigrationCount } from '@rekoda/db';
import { healthStatus } from './health.controller.js';

describe('healthStatus', () => {
  it('is ok when every migration the build carries is applied', () => {
    expect(healthStatus(152, 152)).toBe('ok');
  });

  it('is degraded when the new image runs before its migrations', () => {
    expect(healthStatus(152, 153)).toBe('degraded');
  });

  it('is ok when an older image runs against the newer schema (a rollback)', () => {
    expect(healthStatus(153, 152)).toBe('ok');
  });

  it('is degraded on a bare schema whatever the build carries', () => {
    expect(healthStatus(0, 0)).toBe('degraded');
  });
});

describe('bundledMigrationCount', () => {
  it('counts the journal this build ships', () => {
    expect(bundledMigrationCount()).toBeGreaterThan(0);
  });
});
