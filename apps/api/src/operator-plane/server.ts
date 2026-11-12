/**
 * The dedicated operator process's HTTP surface (OD-51.1).
 *
 * Three routes and nothing else: the two operator plan operations and a health check. The server
 * is Node's own `http`: no framework, no plugin, no body it does not need, because this process
 * holds the one credential that can give a business a plan and its job is to be small.
 *
 * Every plan request is authenticated HERE, by this process, against its own token audience
 * (`authenticate.ts`), then checked for `ops:billing`. The audit actor is the verified token's
 * subject; nothing in the body or in any header set by a forwarding party is believed. Refusals
 * are answered in the API's error shape (`{ statusCode, message }`), so a caller written against
 * the API's operator routes reads these the same way.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Db } from '@rekoda/db';
import type { OperatorScope } from '../auth/operator-identity.js';
import {
  auditActorOf,
  operatorAuthenticator,
  OperatorMissingScope,
  OperatorUnauthenticated,
  requireOperatorScopes,
  type OperatorAuthSettings,
} from './authenticate.js';
import {
  OperatorPlaneRefusal,
  resolvePlanReviewAsOperator,
  setPlanAsOperator,
} from './plan-operations.js';

/** Far above either request body (a UUID, a plan name, a 500-character reason). */
const MAX_BODY_BYTES = 16 * 1024;

export interface OperatorServerDeps {
  operatorDb: Db;
  auth: OperatorAuthSettings;
  release: string;
  commit: string;
  /** Receives the reason of an unexpected failure, already free of request content. */
  onError?: (reason: string) => void;
}

interface Route {
  scopes: readonly OperatorScope[];
  run: (operatorDb: Db, actor: string, body: unknown) => Promise<unknown>;
}

/** The whole surface. A path that is not here does not exist in this process. */
export const OPERATOR_ROUTES: Readonly<Record<string, Route>> = {
  '/v1/businesses/plan': { scopes: ['ops:billing'], run: setPlanAsOperator },
  '/v1/businesses/plan/support-review': {
    scopes: ['ops:billing'],
    run: resolvePlanReviewAsOperator,
  },
};

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpRefusal(413, 'the request body is too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpRefusal(413, 'the request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpRefusal(400, 'the request body is not valid JSON');
  }
}

export function buildOperatorServer(deps: OperatorServerDeps): Server {
  const authenticator = operatorAuthenticator(deps.auth);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, {
        status: 'ok',
        process: 'operator',
        release: deps.release,
        commit: deps.commit,
      });
      return;
    }
    const route = OPERATOR_ROUTES[path];
    if (!route) throw new HttpRefusal(404, 'not found');
    if (req.method !== 'POST') throw new HttpRefusal(405, 'method not allowed');

    /* Identity first, then scope, then the body: an unauthenticated caller learns nothing about
     * what a valid request looks like, and nothing is read from a caller who is not an operator. */
    const identity = await authenticator.identify(req.headers);
    requireOperatorScopes(identity, route.scopes);
    const actor = auditActorOf(identity);
    if (!actor) {
      throw new HttpRefusal(
        400,
        'the operator identity subject cannot be recorded as an audit actor: it must be 1 to 255 printable characters with no spaces',
      );
    }
    const contentType = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(contentType)) {
      throw new HttpRefusal(415, 'the request body must be application/json');
    }
    const body = await readJson(req);
    send(res, 200, await route.run(deps.operatorDb, actor, body));
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof OperatorUnauthenticated) {
        send(res, 401, { statusCode: 401, message: error.message, error: 'Unauthorized' });
      } else if (error instanceof OperatorMissingScope) {
        send(res, 403, { statusCode: 403, message: error.message, error: 'Forbidden' });
      } else if (error instanceof OperatorPlaneRefusal || error instanceof HttpRefusal) {
        send(res, error.status, { statusCode: error.status, message: error.message });
      } else {
        /* The reason is the database's or the runtime's own text, never the request: the body is
         * not included, and a query wrapper's bound values are skipped. */
        deps.onError?.(describe(error));
        send(res, 500, { statusCode: 500, message: 'Internal server error' });
      }
    });
  });
}

/** The reason an operation failed, without the statement or its bound values. */
function describe(error: unknown): string {
  const reasons: string[] = [];
  for (let current: unknown = error, depth = 0; current && depth < 10; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (!message.startsWith('Failed query:')) reasons.push(message);
    if (!(current instanceof Error)) break;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return reasons.join(' | ') || 'unknown error';
}
