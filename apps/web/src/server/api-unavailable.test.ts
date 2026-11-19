/**
 * A call that never reaches the API reads to the merchant as "we could not reach Rekoda", and must
 * also leave a line in the web tier's log saying which call failed and how (the transport error
 * code), so an outage or a dropped connection is diagnosable. Before this, `call()` swallowed the
 * cause: the 19 Nov 2026 CI failure (sign-in stayed on /start with no server error) could not be
 * told apart from a slow server. The line carries the path and the code, never the request body
 * (a phone number on sign-in).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(),
}));

const api = await import('./api');
const fetchMock = vi.fn<typeof fetch>();
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  errorSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('an API the web tier cannot reach', () => {
  it('is ApiUnavailable to the caller, and logs the path and transport code, never the body', async () => {
    const reset = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: reset }));

    await expect(api.requestOtp('+2348171234567')).rejects.toBeInstanceOf(api.ApiUnavailable);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = errorSpy.mock.calls[0]!.map(String).join(' ');
    expect(line).toContain('/v1/auth/otp/request');
    expect(line).toContain('UND_ERR_SOCKET');
    expect(line).not.toContain('2348171234567');
  });

  it('names a refused connection by its code too', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3101'), {
      code: 'ECONNREFUSED',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused }));
    await expect(api.requestOtp('08171234567')).rejects.toBeInstanceOf(api.ApiUnavailable);
    expect(errorSpy.mock.calls[0]!.map(String).join(' ')).toContain('ECONNREFUSED');
  });

  it('logs a path without its query string', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed', { cause: new Error('x') }));
    await expect(api.reminderHistory('session-token', 'INV-0042')).rejects.toBeInstanceOf(
      api.ApiUnavailable,
    );
    const line = errorSpy.mock.calls[0]!.map(String).join(' ');
    expect(line).toContain('/v1/reminders/history');
    expect(line).not.toContain('INV-0042');
  });
});
