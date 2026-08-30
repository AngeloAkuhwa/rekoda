/**
 * Containment, on the class that writes files to a disk (remediation R13).
 *
 * `LocalStorage` is the development and test storage, so an escape here is
 * not a production incident. It is worth pinning anyway for the reason the
 * class itself gives: the check exists because "the keys we generate" is an
 * assumption about every future caller, and a check that does not hold is
 * worse than none, because it reads as though somebody thought about it.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from './r2.storage.js';
import { StorageUnavailable } from './storage.js';

let root: string;

beforeAll(async () => {
  /* A real directory, because the failure being pinned is about paths on a
   * filesystem and a fake root cannot exhibit it. */
  root = await mkdtemp(join(tmpdir(), 'rekoda-storage-'));
});

describe('a key may not escape the storage root', () => {
  /**
   * The case the old check let through.
   *
   * It asked whether the resolved path's TEXT began with the root's text, so
   * a sibling directory whose name merely starts with the root's name passed:
   * `/var/data/base` + `../base-evil/x` resolves to `/var/data/base-evil/x`,
   * which does begin with `/var/data/base`. This is the whole finding.
   */
  it('refuses a sibling directory sharing the root as a name prefix', async () => {
    const storage = new LocalStorage(root);
    /* The sibling has to be built from the ACTUAL root name, suffix and all.
     * A hand-written `../rekoda-storage-evil` does not reproduce anything:
     * the root carries mkdtemp's random suffix, so the old check rejected
     * that key correctly, by accident, and the test would have passed on the
     * unfixed code while appearing to prove the opposite. */
    const escape = `../${basename(root)}-evil/stolen.pdf`;
    await expect(storage.put(escape, Buffer.from('x'))).rejects.toThrow(StorageUnavailable);
  });

  it.each([
    ['climbing out', '../../etc/passwd'],
    ['climbing out mid-key', 'invoices/../../../etc/passwd'],
    ['the root itself, which is a directory', '.'],
    ['a climb dressed up as a name', './../../etc/passwd'],
  ])('refuses %s', async (_label, key) => {
    const storage = new LocalStorage(root);
    await expect(storage.put(key, Buffer.from('x'))).rejects.toThrow(StorageUnavailable);
  });

  it('contains an absolute key rather than obeying it', async () => {
    /* Worth pinning because the obvious expectation is wrong, and a test
     * asserting a refusal here would be asserting something this class does
     * not do and does not need to. `join` treats the second argument as a
     * segment, so `/etc/passwd` becomes `<root>/etc/passwd`: surprising to
     * read, but inside the root, which is the property that matters. */
    const storage = new LocalStorage(root);
    await storage.put('/etc/passwd', Buffer.from('contained'));
    expect(await readFile(join(root, 'etc/passwd'), 'utf8')).toBe('contained');
  });

  it('still stores an ordinary key, nested directories and all', async () => {
    /* The refusal must not be bought by refusing everything: the keys the
     * product actually generates look like this one. */
    const storage = new LocalStorage(root);
    const stored = await storage.put('business/abc/invoice-1.pdf', Buffer.from('%PDF-fake'));
    expect(stored.bytes).toBe(9);
    expect(await readFile(join(root, 'business/abc/invoice-1.pdf'), 'utf8')).toBe('%PDF-fake');
    expect(await storage.get('business/abc/invoice-1.pdf')).toEqual(Buffer.from('%PDF-fake'));
  });

  it('refuses on every door, not just the write', async () => {
    /* A read or a delete that escapes is the same bug wearing a different
     * verb, and the deletion queue calls exactly that door. */
    const storage = new LocalStorage(root);
    await expect(storage.get('../rekoda-storage-evil/stolen.pdf')).rejects.toThrow(
      StorageUnavailable,
    );
    await expect(storage.delete('../rekoda-storage-evil/stolen.pdf')).rejects.toThrow(
      StorageUnavailable,
    );
  });
});
