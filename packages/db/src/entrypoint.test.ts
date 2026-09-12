/**
 * The entrypoint guard must answer the same on POSIX and Windows, and for a
 * path with a space (#237). The string comparison it replaced,
 * `import.meta.url === \`file://${argv[1]}\``, fails the Windows and the
 * space cases on every platform: these fixtures pin the fix.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from './entrypoint.js';

const abs = (...parts: string[]) => resolve(...parts);

describe('isEntrypoint', () => {
  it('is true for the script Node was started with, on this platform', () => {
    const script = abs('srv', 'app', 'dist', 'main.js');
    expect(isEntrypoint(pathToFileURL(script).href, script)).toBe(true);
  });

  it('is true when the path contains a space (percent-encoded in the URL, literal in argv)', () => {
    const script = abs('srv', 'my app', 'dist', 'main.js');
    const url = pathToFileURL(script).href;
    expect(url).toContain('%20');
    expect(isEntrypoint(url, script)).toBe(true);
    // The replaced predicate could never match this input.
    expect(url === `file://${script}`).toBe(false);
  });

  it('is true when argv[1] is relative to the working directory', () => {
    const relativeScript = ['dist', 'main.js'].join(sep);
    const script = abs(relativeScript);
    expect(isEntrypoint(pathToFileURL(script).href, relativeScript)).toBe(true);
  });

  it('is true for a Windows-shaped argv[1] on Windows only', () => {
    const script = process.platform === 'win32' ? 'C:\\app\\dist\\main.js' : '/app/dist/main.js';
    const url = pathToFileURL(script).href;
    expect(isEntrypoint(url, script)).toBe(true);
    if (process.platform === 'win32') {
      // Backslashes and the drive letter are exactly what the old string form missed.
      expect(url === `file://${script}`).toBe(false);
    }
  });

  it('is false when the module is imported rather than run', () => {
    const script = abs('srv', 'app', 'dist', 'main.js');
    const runner = abs('srv', 'app', 'node_modules', '.bin', 'vitest');
    expect(isEntrypoint(pathToFileURL(script).href, runner)).toBe(false);
  });

  /**
   * Run from an app that depends on the package, `node
   * node_modules/@rekoda/db/dist/migrate.js` reaches the script through a
   * pnpm symlink. Node gives the main module its REAL path, so a comparison
   * against the path as typed never matched and the migrator exited 0 having
   * applied nothing: the #237 failure again, by another road (found building
   * G-01, whose migrate job first ran it that way).
   */
  it('is true when argv[1] reaches the script through a symlinked directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'));
    try {
      const real = join(dir, 'real', 'dist');
      mkdirSync(real, { recursive: true });
      const script = join(real, 'migrate.js');
      writeFileSync(script, '');
      // A junction on Windows needs no privilege; a plain symlink elsewhere.
      symlinkSync(join(dir, 'real'), join(dir, 'linked'), 'junction');
      const typed = join(dir, 'linked', 'dist', 'migrate.js');
      expect(isEntrypoint(pathToFileURL(script).href, typed)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when Node was started without a script', () => {
    const script = abs('srv', 'app', 'dist', 'main.js');
    expect(isEntrypoint(pathToFileURL(script).href, undefined)).toBe(false);
    expect(isEntrypoint(pathToFileURL(script).href, '')).toBe(false);
  });
});
