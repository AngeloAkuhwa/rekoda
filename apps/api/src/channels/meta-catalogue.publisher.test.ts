/**
 * What `MetaCataloguePublisher` puts on the wire, and what it does when Graph
 * does not answer (G-54).
 *
 * The publisher called `fetch` with no timeout, so a Graph endpoint that
 * accepted the connection and then said nothing held the catalogue sweep
 * forever: the sweep awaits each business in turn, and a hung call never
 * throws for its catch to see. Run against a local server that can be told to
 * stall, the way the Meta sender's wire tests are.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetaCataloguePublisher, catalogPrice } from './meta-catalogue.publisher.js';

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

type Mode = 'ok' | 'refuse' | 'validation' | 'silent' | 'headers-then-silence';

let server: Server;
let baseUrl: string;
let seen: Seen[];
let mode: Mode;
const stalled = new Set<ServerResponse>();

const TOKEN = 'EAAB-secret-access-token';
const ITEMS = [
  {
    retailerId: 'sku-1',
    name: 'Rice',
    priceK: 150_000,
    currency: 'NGN' as const,
    availability: 'in stock' as const,
  },
  {
    retailerId: 'sku-2',
    name: 'Beans',
    priceK: 99_950,
    currency: 'NGN' as const,
    availability: 'out of stock' as const,
  },
];

function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  seen.push({
    method: req.method ?? '',
    url: req.url ?? '',
    authorization: req.headers['authorization'],
    body: raw ? JSON.parse(raw) : null,
  });
  if (mode === 'silent') {
    stalled.add(res);
    return;
  }
  if (mode === 'headers-then-silence') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"validation_status":[');
    stalled.add(res);
    return;
  }
  if (mode === 'refuse') {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid catalogue' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    mode === 'validation'
      ? JSON.stringify({
          validation_status: [
            { retailer_id: 'sku-2', errors: [{ message: 'price missing' }, { message: 'bad' }] },
          ],
        })
      : '{}',
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of stalled) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  mode = 'ok';
  for (const res of stalled) res.destroy();
  stalled.clear();
});

const publish = (publisher: MetaCataloguePublisher) =>
  publisher.publish({ accessToken: TOKEN, catalogueId: 'cat 1', items: ITEMS });

describe('catalogPrice', () => {
  it('formats integer kobo without a float', () => {
    expect(catalogPrice(150_000, 'NGN')).toBe('1500.00 NGN');
    expect(catalogPrice(99_950, 'NGN')).toBe('999.50 NGN');
    expect(catalogPrice(5, 'NGN')).toBe('0.05 NGN');
  });
});

describe('MetaCataloguePublisher on the wire', () => {
  it('posts one items_batch with the bearer token and every item priced from kobo', async () => {
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', baseUrl));
    expect(outcomes).toEqual([
      { retailerId: 'sku-1', ok: true },
      { retailerId: 'sku-2', ok: true },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/v21.0/cat%201/items_batch',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(
      (seen[0]!.body as { requests: Array<{ data: { price: string } }> }).requests.map(
        (r) => r.data.price,
      ),
    ).toEqual(['1500.00 NGN', '999.50 NGN']);
  });

  it('reports only the items Meta named as failed', async () => {
    mode = 'validation';
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', baseUrl));
    expect(outcomes).toEqual([
      { retailerId: 'sku-1', ok: true },
      { retailerId: 'sku-2', ok: false, error: 'price missing; bad' },
    ]);
  });

  it('fails every item, with the status, when the batch is refused', async () => {
    mode = 'refuse';
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', baseUrl));
    expect(outcomes.map((o) => o.ok)).toEqual([false, false]);
    expect(outcomes[0]).toMatchObject({ error: expect.stringContaining('HTTP 400') });
  });
});

describe('when Graph does not answer (G-54)', () => {
  it('gives up on a server that accepts the request and says nothing', async () => {
    mode = 'silent';
    const started = Date.now();
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', baseUrl, 150));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcomes.map((o) => o.ok)).toEqual([false, false]);
    expect(outcomes.map((o) => o.retailerId)).toEqual(['sku-1', 'sku-2']);
  });

  it('gives up on a server that sends headers and then stalls the body', async () => {
    mode = 'headers-then-silence';
    const started = Date.now();
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', baseUrl, 150));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(outcomes.map((o) => o.ok)).toEqual([false, false]);
  });

  it('names the class of failure, never the token or the request', async () => {
    mode = 'silent';
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', baseUrl, 150));
    const error = (outcomes[0] as { error: string }).error;
    expect(error).toMatch(/did not answer/);
    expect(error).not.toContain(TOKEN);
    expect(error).not.toContain('cat');
  });

  it('fails every item, not the sweep, when nothing is listening', async () => {
    const closed = await new Promise<string>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(`http://127.0.0.1:${port}`));
      });
    });
    const outcomes = await publish(new MetaCataloguePublisher('v21.0', closed, 500));
    expect(outcomes.map((o) => o.ok)).toEqual([false, false]);
  });
});
