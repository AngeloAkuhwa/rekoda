/**
 * Every public failure, in the one shape v1 promised (canonical spec §27).
 *
 * Nest's default error body is `{statusCode, message, error}`, and it leaks
 * whatever the thrower happened to say: a zod message, a Nest string, a
 * guard's prose. That is fine for the dashboard, whose only client ships
 * from this repository. It is not fine for an API somebody else's code
 * branches on for years, so this filter maps every exception onto the closed
 * code set in `publicErrorResponse` and drops everything else.
 *
 * Codes come from the STATUS, not from the message, with one exception: the
 * entitlement refusal, which the guard marks explicitly because "you have a
 * working key but have not bought the API" is the one 403 a developer can
 * actually act on and must not be confused with a permission refusal.
 */
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { publicApi } from '@rekoda/contracts';

type PublicErrorCode = publicApi.v1.PublicErrorCode;

/** The minimum a Fastify reply must be for an error to go back down it. */
interface ErrorReply {
  header(name: string, value: string): ErrorReply;
  code(status: number): ErrorReply;
  send(body: unknown): unknown;
}

/** Marks a refusal as "the business has not bought the API", not a permission. */
export class NotEntitledException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.FORBIDDEN);
  }
}

/**
 * Marks a refusal as "the month's capacity is spent".
 *
 * 429 like the rate limit, because both mean "not now" to every proxy and
 * client library in between, and the CODE is what separates them: one is
 * worth retrying in a minute and the other is not worth retrying at all.
 */
export class QuotaExhaustedException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Marks a refusal as "this key may not write", which is `forbidden`.
 *
 * Not a new code: a sandbox key IS a credential that may not do this, which
 * is exactly what `forbidden` already means. Inventing `sandbox_write` would
 * make a v1 client learn a code for a distinction the message already makes.
 */
export class SandboxWriteException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.FORBIDDEN);
  }
}

@Catch()
export class PublicApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(PublicApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<ErrorReply>();

    if (!(exception instanceof HttpException)) {
      /* Logged here and nowhere else: an unexpected throw is the one case
       * where the operator needs the detail and the caller must not have
       * it. What goes out is a bare `internal`. */
      this.log.error('public API request failed', exception as Error);
      reply.code(500).send(body('internal', 'something went wrong on our side'));
      return;
    }

    const status = exception.getStatus();
    const payload = exception.getResponse();
    const code = codeFor(exception, status);
    const message = messageFor(payload, code);

    /* `quota_exhausted` shares the 429 and NOT the Retry-After: telling a
     * caller to come back in forty seconds when the month is spent would be
     * an instruction to keep failing. */
    if (code === 'rate_limited') {
      const retryAfterSeconds = retryAfterFrom(payload);
      /* The header AND the field. A well-written client reads the header; a
       * client written in an hour reads the JSON. Neither should have to
       * guess when to come back. */
      reply.header('retry-after', String(retryAfterSeconds));
      reply.code(status).send(body(code, message, { retryAfterSeconds }));
      return;
    }

    reply.code(status).send(body(code, message));
  }
}

function codeFor(exception: HttpException, status: number): PublicErrorCode {
  if (exception instanceof NotEntitledException) return 'not_entitled';
  if (exception instanceof QuotaExhaustedException) return 'quota_exhausted';
  switch (status) {
    case HttpStatus.UNAUTHORIZED:
      return 'unauthenticated';
    case HttpStatus.FORBIDDEN:
      return 'forbidden';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'rate_limited';
    case HttpStatus.BAD_REQUEST:
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'invalid_request';
    default:
      return status >= 500 ? 'internal' : 'invalid_request';
  }
}

/**
 * The prose, taken from the exception only when the exception chose it.
 *
 * A 500 never carries the thrower's message: the one place an internal
 * detail reaches a public client is a message somebody wrote for a log.
 */
function messageFor(payload: unknown, code: PublicErrorCode): string {
  if (code === 'internal') return 'something went wrong on our side';
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'message' in payload) {
    const message = (payload as { message: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  }
  return code.replace(/_/g, ' ');
}

function retryAfterFrom(payload: unknown): number {
  if (payload && typeof payload === 'object' && 'retryAfterSeconds' in payload) {
    const value = (payload as { retryAfterSeconds: unknown }).retryAfterSeconds;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.ceil(value);
  }
  return 60;
}

function body(
  code: PublicErrorCode,
  message: string,
  extra: { retryAfterSeconds?: number } = {},
): publicApi.v1.PublicErrorResponse {
  return publicApi.v1.publicErrorResponse.parse({ error: { code, message, ...extra } });
}
