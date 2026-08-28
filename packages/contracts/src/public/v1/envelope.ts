/**
 * What every v1 response looks like when it is not the thing you asked for
 * (canonical spec §27).
 *
 * The dashboard can afford Nest's default error body, because the only
 * client is a page written in the same repository on the same day. A public
 * API cannot: somebody else's code branches on these values, in a language
 * this repository will never see, for years. So the machine-readable part is
 * a CLOSED set of codes that is part of the version contract, and the
 * human-readable part is explicitly not: `message` may be reworded at any
 * time and no client should ever match on it.
 */
import { z } from 'zod';

/**
 * The codes a v1 client may branch on. Adding one is a v1 change (a client
 * that switches exhaustively meets an unknown); removing or renaming one is
 * a new version.
 */
export const PUBLIC_ERROR_CODES = [
  /** No credential, or one that is not usable. Never says which. */
  'unauthenticated',
  /** A live key, refused: the business lacks the API entitlement. */
  'not_entitled',
  /** A live key, refused: this key may not do this. */
  'forbidden',
  /** The request was understood and is wrong. `details` says how. */
  'invalid_request',
  /** No such thing, or nothing this caller may see. The two are one answer. */
  'not_found',
  /** The ceiling. `retryAfterSeconds` says when to come back. */
  'rate_limited',
  /** A version segment this API does not serve. */
  'unsupported_version',
  /** Ours, not yours. Carries nothing about what broke. */
  'internal',
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export const publicErrorResponse = z.object({
  error: z.object({
    code: z.enum(PUBLIC_ERROR_CODES),
    /** Prose for a human reading a log. Not a contract; never match on it. */
    message: z.string(),
    /** Field-level detail for `invalid_request`, keyed by field path. */
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    /** Present on `rate_limited`, mirroring the `Retry-After` header. */
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
});
export type PublicErrorResponse = z.infer<typeof publicErrorResponse>;

/**
 * The shape of every list this API returns.
 *
 * Cursor rather than page number, because a page number over a table that is
 * still being written to shows a caller the same row twice and skips
 * another. `nextCursor` is null when the list is finished, which is the one
 * thing a client has to check.
 */
export function publicPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/** The header carrying the version that actually answered. */
export const PUBLIC_VERSION_HEADER = 'rekoda-api-version';
