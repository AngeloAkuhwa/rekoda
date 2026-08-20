import 'server-only';
import {
  meResponse,
  paymentConnectionResponse,
  paymentExceptionsResponse,
  paymentsListResponse,
  requestOtpResponse,
  sessionResponse,
  setupStateResponse,
  verifyOtpResponse,
  type MeResponse,
  type PaymentConnectionResponse,
  type PaymentExceptionsResponse,
  type PaymentsListResponse,
  type SubmitConnectionRequest,
  type RequestOtpResponse,
  type SessionResponse,
  type SetupStateResponse,
  type VerifyOtpResponse,
} from '@rekoda/contracts';

/**
 * The web tier's only route to identity.
 *
 * Every response is parsed against the shared zod contract rather than cast, so
 * a field the API renames surfaces here as a thrown error at the boundary
 * instead of `undefined` three components deep in front of a merchant.
 *
 * Nothing in this file holds a database handle or a signing secret. The web
 * tier cannot mint a session, cannot validate one, and cannot read another
 * tenant's rows even by mistake — it can only carry opaque tokens the API
 * issued.
 */
const BASE = process.env.REKODA_API_URL ?? 'http://127.0.0.1:3001';

export class ApiUnauthorised extends Error {}
export class ApiUnavailable extends Error {}
/**
 * The API answered something no caller anticipated.
 *
 * This exists because its absence hid a real bug: a bodyless DELETE was being
 * sent with `content-type: application/json`, Fastify rejected it with 400, and
 * `call()` returned that 400 to a caller that only looked for 401. Sign-out
 * therefore cleared the cookie and left the session live server-side — a logout
 * that logged nobody out, reported as success. Unexpected statuses are now
 * loud.
 */
export class ApiUnexpectedStatus extends Error {
  constructor(path: string, status: number) {
    super(`unexpected ${status} from ${path}`);
  }
}

interface CallOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses this caller handles. Anything else throws rather than returning. */
  expect: number[];
}

async function call(options: CallOptions): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${options.path}`, {
      method: options.method,
      headers: {
        // Only when there is actually a body. Fastify rejects a bodyless
        // request that claims to carry JSON, which is how sign-out broke.
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      // Spread rather than `body: undefined` — under exactOptionalPropertyTypes
      // an explicit undefined is not the same as an absent property.
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // Identity is never served from a cache, at any layer.
      cache: 'no-store',
    });
  } catch (cause) {
    // A dead API must read as "we are down", not as a merchant mistake.
    throw new ApiUnavailable(`cannot reach the Rekoda API at ${BASE}`, { cause });
  }

  if (!options.expect.includes(response.status)) {
    throw new ApiUnexpectedStatus(options.path, response.status);
  }
  if (response.status === 204) return { status: 204, json: null };
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
}

export async function requestOtp(phone: string): Promise<RequestOtpResponse | 'invalid_phone'> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/auth/otp/request',
    body: { phone },
    expect: [200, 400],
  });
  if (status === 400) return 'invalid_phone';
  return requestOtpResponse.parse(json);
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<VerifyOtpResponse | 'invalid_phone'> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/auth/otp/verify',
    body: { phone, code },
    expect: [200, 400],
  });
  if (status === 400) return 'invalid_phone';
  return verifyOtpResponse.parse(json);
}

/** Null rather than throwing: an absent or forged grant is a redirect, not a crash. */
export async function readSetupState(setupToken: string): Promise<SetupStateResponse | null> {
  const { status, json } = await call({
    method: 'GET',
    path: '/v1/auth/setup',
    headers: { 'x-rekoda-setup-token': setupToken },
    expect: [200, 401],
  });
  if (status === 401) return null;
  return setupStateResponse.parse(json);
}

export async function createBusiness(
  setupToken: string,
  input: { name: string; businessType: string | null },
): Promise<SessionResponse> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/businesses',
    body: input,
    headers: { 'x-rekoda-setup-token': setupToken },
    expect: [201, 401],
  });
  if (status === 401) throw new ApiUnauthorised('setup grant is missing, expired or forged');
  return sessionResponse.parse(json);
}

/** Null rather than throwing — an expired session is an ordinary redirect. */
export async function me(sessionToken: string): Promise<MeResponse | null> {
  const { status, json } = await call({
    method: 'GET',
    path: '/v1/auth/me',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 401],
  });
  if (status === 401) return null;
  return meResponse.parse(json);
}

/**
 * Revoke server-side. Throws on anything but a clean 204, so a sign-out that
 * did not actually revoke can never be reported as one.
 */
export async function signOut(sessionToken: string): Promise<void> {
  await call({
    method: 'DELETE',
    path: '/v1/auth/session',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [204],
  });
}

/* ── the Payment Hub (docs/payments-v1.md §3–5, §35) ─────────────────────── */

export async function paymentConnection(sessionToken: string): Promise<PaymentConnectionResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/connection',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return paymentConnectionResponse.parse(json);
}

export type SubmitConnectionOutcome =
  | { state: 'submitted'; connection: PaymentConnectionResponse; held: boolean }
  | { state: 'invalid' }
  | { state: 'unavailable' };

export async function submitPaymentConnection(
  sessionToken: string,
  input: SubmitConnectionRequest,
): Promise<SubmitConnectionOutcome> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/payments/connection',
    body: input,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400, 503],
  });
  if (status === 400) return { state: 'invalid' };
  if (status === 503) return { state: 'unavailable' };
  const parsed = paymentConnectionResponse.parse(json);
  const held = typeof json === 'object' && json !== null && 'held' in json;
  return { state: 'submitted', connection: parsed, held };
}

export async function paymentsList(sessionToken: string): Promise<PaymentsListResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/list',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return paymentsListResponse.parse(json);
}

export async function paymentExceptions(sessionToken: string): Promise<PaymentExceptionsResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/exceptions',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return paymentExceptionsResponse.parse(json);
}
