/**
 * When /health may say `ok` (G-01). The container health checks, `up --wait`
 * and the deploy runbook all read this one word, so it must mean "every
 * migration this build needs is present", in both directions of a deploy,
 * and by tag rather than by count.
 */
import { describe, expect, it } from 'vitest';
import { bundledMigrationTags } from '@rekoda/db';
import { healthStatus } from './health.controller.js';

const tags = (...t: string[]) => new Set(t);

describe('healthStatus', () => {
  it('is ok when every migration the build carries is applied', () => {
    expect(healthStatus(tags('0000_a', '0001_b'), ['0000_a', '0001_b'])).toBe('ok');
  });

  it('is degraded when the new image runs before its migrations', () => {
    expect(healthStatus(tags('0000_a'), ['0000_a', '0001_b'])).toBe('degraded');
  });

  it('is ok when an older image runs against the newer schema (a rollback)', () => {
    expect(healthStatus(tags('0000_a', '0001_b', '0002_c'), ['0000_a', '0001_b'])).toBe('ok');
  });

  it('is degraded when the counts agree but a needed migration is missing', () => {
    expect(healthStatus(tags('0000_a', '0001_other'), ['0000_a', '0001_b'])).toBe('degraded');
  });

  it('is degraded on a bare schema whatever the build carries', () => {
    expect(healthStatus(tags(), [])).toBe('degraded');
  });
});

describe('bundledMigrationTags', () => {
  it('lists the journal this build ships, in order and without repeats', () => {
    const shipped = bundledMigrationTags();
    expect(shipped.length).toBeGreaterThan(0);
    expect(shipped[0]).toBe('0000_init');
    expect(new Set(shipped).size).toBe(shipped.length);
  });
});
