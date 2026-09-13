/**
 * The edge-check job's entry (G-74, G-75). Caddy waits for it to exit 0, so
 * the one outcome it must never have is exiting 0 without checking: a gate
 * that decides it was imported rather than run, and skips itself, reads to
 * compose exactly like a pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

class Exit extends Error {
  readonly code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const original = process.env['REKODA_EDGE_PROXIES'];

/** Runs the entry module afresh with `value` in the environment. */
async function runWith(value: string | undefined) {
  if (value === undefined) delete process.env['REKODA_EDGE_PROXIES'];
  else process.env['REKODA_EDGE_PROXIES'] = value;
  vi.resetModules();
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let exitCode: number | undefined | null = null;
  try {
    await import('./edge-check.js');
  } catch (thrown) {
    if (!(thrown instanceof Exit)) throw thrown;
    exitCode = thrown.code;
  }
  const result = {
    exitCode,
    exitCalls: exit.mock.calls.length,
    error: error.mock.calls.flat().join('\n'),
    log: log.mock.calls.flat().join('\n'),
  };
  vi.restoreAllMocks();
  return result;
}

afterEach(() => {
  if (original === undefined) delete process.env['REKODA_EDGE_PROXIES'];
  else process.env['REKODA_EDGE_PROXIES'] = original;
});

describe('the edge-check entry', () => {
  /* Under the test runner process.argv[1] is vitest, not this module: the
   * very mismatch that made the old entry-point test skip the check. */
  it('checks whatever process.argv says, so it can never skip itself', async () => {
    expect(process.argv[1]).not.toMatch(/edge-check/);
    const run = await runWith('0.0.0.0/0');
    expect(run.exitCode).toBe(1);
    expect(run.error).toMatch(/REKODA_EDGE_PROXIES trusts 0\.0\.0\.0\/0/);
  });

  it.each(['::/0', 'private_ranges', '172.16.0.0/12', '104.16.0.0/13,2606:4700::/32'])(
    'exits 1 for %s, naming the variable',
    async (value) => {
      const run = await runWith(value);
      expect(run.exitCode).toBe(1);
      expect(run.error).toMatch(/REKODA_EDGE_PROXIES/);
    },
  );

  it('exits normally for the documented empty value, saying what Caddy will do', async () => {
    for (const value of [undefined, '']) {
      const run = await runWith(value);
      expect(run.exitCalls).toBe(0);
      expect(run.log).toMatch(/none, so Caddy believes the TCP peer alone/);
    }
  });

  it("exits normally for Cloudflare's ranges, naming them", async () => {
    const run = await runWith('173.245.48.0/20 2400:cb00::/32');
    expect(run.exitCalls).toBe(0);
    expect(run.log).toBe('edge proxies: 173.245.48.0/20 2400:cb00::/32');
  });
});
