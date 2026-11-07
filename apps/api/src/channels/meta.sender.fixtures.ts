/**
 * A real HTTP server standing in for Graph, for the Meta adapter suites that are split from
 * meta.sender.test.ts. Each suite calls `useGraphServer()` once at its top level; Vitest gives every
 * test file its own copy of this module, so each suite gets its own server. Every request is
 * recorded, and `respond` is reset before each test to a 200 carrying one message id.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach } from 'vitest';

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  raw: string;
  /** The body decoded as UTF-8, for JSON bodies whose parameters may not be ASCII. */
  text: string;
}

export interface GraphServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  respond: (req: IncomingMessage, res: ServerResponse) => void;
}

const ok = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ messages: [{ id: 'wamid.SENT1' }] }));
};

export function useGraphServer(): GraphServer {
  let server: Server;
  let baseUrl = '';
  const requests: RecordedRequest[] = [];
  const graph: GraphServer = {
    get baseUrl() {
      return baseUrl;
    },
    requests,
    respond: ok,
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
          raw: Buffer.concat(chunks).toString('binary'),
          text: Buffer.concat(chunks).toString('utf8'),
        });
        graph.respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    graph.respond = ok;
  });

  return graph;
}
