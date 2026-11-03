import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const journalPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations',
  'meta',
  '_journal.json',
);

interface Entry {
  idx: number;
  when: number;
  tag: string;
}

const entries = (JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Entry[] }).entries;

describe('migration journal order', () => {
  it('applies migrations in filename order, with increasing idx and timestamps', () => {
    const tags = entries.map((e) => e.tag);
    expect(tags).toEqual([...tags].sort());
    entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      if (i > 0) expect(e.when).toBeGreaterThan(entries[i - 1]!.when);
    });
  });

  it('G-109: installs the trial-exit trigger before the trial backfills', () => {
    const at = (tag: string) => entries.findIndex((e) => e.tag === tag);
    expect(at('0176_trial_leaves_month_rows')).toBeGreaterThanOrEqual(0);
    expect(at('0176_trial_leaves_month_rows')).toBeLessThan(at('0177_trial_meter_backfill'));
    expect(at('0176_trial_leaves_month_rows')).toBeLessThan(at('0178_trial_reservations_meter'));
  });
});
