/**
 * What `R2Storage` puts on the wire (G-40).
 *
 * `r2.storage.test.ts` exercises the filesystem storage only, so nothing
 * proved the class that holds every merchant document in production: that the
 * bucket and key reach the right path, that a missing object reads as null and
 * not as an error, that a refused request propagates (the erasure queue keeps
 * retrying on a thrown delete), and that the probe works end to end. Run
 * against a local S3-shaped server, the way the Meta adapter is.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { R2Storage } from './r2.storage.js';
import { probeStorage, StorageUnavailable, type DocumentStorage } from './storage.js';

interface Seen {
  method: string;
  url: string;
  contentType: string | undefined;
  body: Buffer;
}

let server: Server;
let endpoint: string;
let seen: Seen[];
let objects: Map<string, Buffer>;
let refuseAll: boolean;

const NO_SUCH_KEY =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>';
const ACCESS_DENIED =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>no</Message></Error>';

function handle(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  /* The SDK adds `?x-id=<Operation>`; the object path is what matters. */
  const url = (req.url ?? '').split('?')[0] ?? '';
  seen.push({ method: req.method ?? '', url, contentType: req.headers['content-type'], body });
  if (refuseAll) {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end(ACCESS_DENIED);
    return;
  }
  if (req.method === 'PUT') {
    objects.set(url, body);
    res.writeHead(200, { etag: '"abc"' });
    res.end();
  } else if (req.method === 'GET') {
    const found = objects.get(url);
    if (!found) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end(NO_SUCH_KEY);
      return;
    }
    res.writeHead(200, { 'content-length': String(found.length) });
    res.end(found);
  } else if (req.method === 'DELETE') {
    objects.delete(url);
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(405);
    res.end();
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  objects = new Map();
  refuseAll = false;
});

const storage = () =>
  new R2Storage(
    '0123456789abcdef0123456789abcdef',
    'AKIAEXAMPLE',
    'secret-example',
    'rekoda-documents',
    endpoint,
  );

describe('R2Storage on the wire', () => {
  it('PUTs the bytes to bucket/key with their content type, and reports their size', async () => {
    const stored = await storage().put(
      'documents/b/invoice/x.pdf',
      Buffer.from('%PDF-1'),
      'application/pdf',
    );
    expect(stored).toEqual({ key: 'documents/b/invoice/x.pdf', bytes: 6 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      url: '/rekoda-documents/documents/b/invoice/x.pdf',
      contentType: 'application/pdf',
    });
    expect(seen[0]!.body.toString()).toBe('%PDF-1');
  });

  it('reads back exactly the bytes it wrote', async () => {
    const s = storage();
    await s.put('k.pdf', Buffer.from('hello'), 'application/pdf');
    expect((await s.get('k.pdf'))?.toString()).toBe('hello');
  });

  it('answers null, not an error, for a key that is not there', async () => {
    expect(await storage().get('nothing.pdf')).toBeNull();
  });

  it('DELETEs bucket/key, and a delete of a missing key succeeds', async () => {
    const s = storage();
    await s.put('k.pdf', Buffer.from('x'), 'application/pdf');
    await s.delete('k.pdf');
    await s.delete('k.pdf');
    expect(seen.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual([
      '/rekoda-documents/k.pdf',
      '/rekoda-documents/k.pdf',
    ]);
    expect(await s.get('k.pdf')).toBeNull();
  });

  it('propagates a refused request on every operation', async () => {
    refuseAll = true;
    const s = storage();
    await expect(s.put('k.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow();
    await expect(s.get('k.pdf')).rejects.toThrow();
    await expect(s.delete('k.pdf')).rejects.toThrow();
  });
});

describe('probeStorage', () => {
  it('passes against a working bucket and leaves nothing behind', async () => {
    await expect(probeStorage(storage())).resolves.toBeUndefined();
    expect(objects.size).toBe(0);
    expect(seen.map((r) => r.method)).toEqual(['PUT', 'GET', 'DELETE', 'GET']);
    expect(seen.every((r) => r.url.startsWith('/rekoda-documents/probe/'))).toBe(true);
  });

  it('names the write step when the credentials are refused, without the provider message', async () => {
    refuseAll = true;
    const error = await probeStorage(storage()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageUnavailable);
    /* The failed step and the provider's error CODE; the response text is not repeated. */
    expect((error as Error).message).toBe('storage probe: write failed (AccessDenied)');
  });

  it('fails when the object read back is not the object written', async () => {
    const wrong: DocumentStorage = {
      put: (key, body) => Promise.resolve({ key, bytes: body.length }),
      get: () => Promise.resolve(Buffer.from('something else')),
      delete: () => Promise.resolve(),
    };
    await expect(probeStorage(wrong)).rejects.toThrow(/not the object written/);
  });

  it('fails when the object survives a delete', async () => {
    const kept = new Map<string, Buffer>();
    const sticky: DocumentStorage = {
      put: (key, body) => {
        kept.set(key, body);
        return Promise.resolve({ key, bytes: body.length });
      },
      get: (key) => Promise.resolve(kept.get(key) ?? null),
      delete: () => Promise.resolve(),
    };
    await expect(probeStorage(sticky)).rejects.toThrow(/still readable after delete/);
  });

  it('fails when delete is not permitted', async () => {
    const kept = new Map<string, Buffer>();
    const noDelete: DocumentStorage = {
      put: (key, body) => {
        kept.set(key, body);
        return Promise.resolve({ key, bytes: body.length });
      },
      get: (key) => Promise.resolve(kept.get(key) ?? null),
      delete: () => Promise.reject(new Error('Forbidden')),
    };
    await expect(probeStorage(noDelete)).rejects.toThrow(/delete failed/);
  });
});
