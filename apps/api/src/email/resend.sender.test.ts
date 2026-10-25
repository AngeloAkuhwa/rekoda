import { describe, expect, it } from 'vitest';
import { RESEND_SEND_URL, ResendEmailSender } from './resend.sender.js';

type Call = { url: string; init: RequestInit };

function sender(respond: () => Response | Promise<Response>, calls: Call[] = []) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return new ResendEmailSender({
    apiKey: 're_test_key',
    from: 'Rekoda <billing@example.com>',
    timeoutMs: 50,
    fetchImpl,
  });
}

const MESSAGE = { to: 'owner@shop.example', subject: 'Confirm', text: 'Open the link' };

describe('ResendEmailSender', () => {
  it('posts one JSON message to the fixed Resend endpoint with the key in the header only', async () => {
    const calls: Call[] = [];
    await sender(() => new Response('{"id":"x"}', { status: 200 }), calls).send(MESSAGE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_SEND_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer re_test_key');
    expect(headers['idempotency-key']).toBeUndefined();
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({
      from: 'Rekoda <billing@example.com>',
      to: ['owner@shop.example'],
      subject: 'Confirm',
      text: 'Open the link',
    });
    expect(JSON.stringify(body)).not.toContain('re_test_key');
  });

  it('passes an idempotency key through so a provider can drop a retried duplicate', async () => {
    const calls: Call[] = [];
    await sender(() => new Response('{}', { status: 200 }), calls).send({
      ...MESSAGE,
      idempotencyKey: 'billing-confirm-1',
    });
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe(
      'billing-confirm-1',
    );
  });

  it('throws on a non-2xx and never puts the response body, recipient or key in the error', async () => {
    const failing = sender(
      () => new Response('rejected owner@shop.example re_test_key', { status: 422 }),
    );
    const error = await failing.send(MESSAGE).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toBe('resend send failed with 422');
    expect(error!.message).not.toContain('owner@shop.example');
    expect(error!.message).not.toContain('re_test_key');
  });

  it('throws when the provider is unreachable, naming only the failure kind', async () => {
    const down = sender(() => {
      throw new TypeError('connect ECONNREFUSED 10.0.0.1 for owner@shop.example');
    });
    const error = await down.send(MESSAGE).then(
      () => null,
      (e: Error) => e,
    );
    expect(error!.message).toBe('resend request failed: TypeError');
  });

  it('aborts a request that outlives its budget', async () => {
    const slow = new ResendEmailSender({
      apiKey: 're_test_key',
      from: 'billing@example.com',
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        })) as unknown as typeof fetch,
    });
    await expect(slow.send(MESSAGE)).rejects.toThrow('resend request failed: AbortError');
  });
});
