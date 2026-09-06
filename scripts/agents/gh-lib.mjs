#!/usr/bin/env node
/**
 * The one canonical GitHub-API access layer for the agent scripts: gh()
 * shells to the gh CLI with execFileSync array arguments (untrusted text
 * never touches a shell), and ghPagedComplete() paginates to EXHAUSTION
 * with a defensive ceiling. `complete: false` (ceiling hit, or API
 * failure) must be treated as UNPROVABLE state by every caller — fail
 * closed, never as absence.
 */
import { execFileSync } from 'node:child_process';

export function gh(pathname, extra = []) {
  return JSON.parse(
    execFileSync('gh', ['api', pathname, ...extra], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

export function ghPagedComplete(pathname, maxPages = 30) {
  const items = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const chunk = gh(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...chunk);
      if (chunk.length < 100) return { items, complete: true };
    }
    return { items, complete: false }; // ceiling hit with pages remaining
  } catch {
    return { items, complete: false }; // API failure: unprovable
  }
}
