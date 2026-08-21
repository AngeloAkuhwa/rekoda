/**
 * The Meta adapter, against a real HTTP server.
 *
 * Every message Rekoda sends leaves through this file, and until now nothing
 * asserted what it actually puts on the wire. That matters most for the three
 * TEMPLATES, because Meta validates their shape and rejects a mismatch: a
 * template can be approved and the send still fail, which is the worst
 * possible failure mode - it looks like the approval was the problem.
 *
 * The claims here are the ones a stub cannot make. The authentication code
 * appears TWICE because the copy-code template has a body and a button and
 * Meta counts both. Link previews are off, because a merchant's message can
 * carry a URL and unfurling it is a second fetch of an untrusted address.
 * A document goes in two requests, and the bytes reach Meta and nowhere else.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetaSender } from './meta.sender.js';
import { SendFailed } from './sender.js';

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  raw: string;
}

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

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
      });
      respond(req, res);
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
  requests = [];
  respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: 'wamid.SENT1' }] }));
  };
});

const sender = (
  opts: { otp?: string | null; billing?: string | null; retention?: string | null } = {},
) =>
  new MetaSender(
    'TOKEN123',
    'PNID',
    'v21.0',
    2_000,
    opts.otp === undefined ? 'rekoda_otp' : opts.otp,
    'en',
    opts.billing === undefined ? 'rekoda_billing' : opts.billing,
    'en',
    opts.retention === undefined ? 'rekoda_retention' : opts.retention,
    'en',
    baseUrl,
  );

const bodyOf = (index = 0): Record<string, unknown> =>
  JSON.parse(requests[index]!.raw) as Record<string, unknown>;

describe('the wire', () => {
  it('carries the token and posts to the phone number id', async () => {
    await sender().send({ to: '2348031234567', text: 'Saved' });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/v21.0/PNID/messages');
    expect(requests[0]?.authorization).toBe('Bearer TOKEN123');
  });

  it('turns off link previews on an ordinary reply', async () => {
    await sender().send({ to: '2348031234567', text: 'see rekoda.app' });

    /* A merchant's message can carry a URL, and an unfurled preview is a
     * second network fetch of an address nobody vetted. */
    expect(bodyOf()).toMatchObject({
      type: 'text',
      text: { preview_url: false, body: 'see rekoda.app' },
    });
  });

  it('returns the provider message id, and null when Meta sends none', async () => {
    expect(await sender().send({ to: '234803', text: 'hi' })).toEqual({
      providerMessageId: 'wamid.SENT1',
    });

    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
    };
    expect(await sender().send({ to: '234803', text: 'hi' })).toEqual({
      providerMessageId: null,
    });
  });

  it('fails loudly on a Graph error rather than reporting a send', async () => {
    respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad', code: 131047 } }));
    };
    await expect(sender().send({ to: '234803', text: 'hi' })).rejects.toBeInstanceOf(SendFailed);
  });
});

describe('the authentication template', () => {
  it('sends the code TWICE, for the body and the copy button', async () => {
    await sender().sendAuthCode({ to: '2348031234567', code: '482913' });

    /* Meta counts the parameters of both components. Sending one is rejected
     * as a parameter-count mismatch rather than rendering half a message. */
    expect(bodyOf()).toMatchObject({
      type: 'template',
      template: {
        name: 'rekoda_otp',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '482913' }],
          },
        ],
      },
    });
  });

  it('refuses when no template is configured, and sends nothing', async () => {
    await expect(sender({ otp: null }).sendAuthCode({ to: '234803', code: '1' })).rejects.toThrow(
      /META_OTP_TEMPLATE/,
    );
    // The alternative is a free-form text Meta rejects with 131047, swallowed
    // by the caller. That is how a sign-in flow reaches nobody while passing.
    expect(requests).toHaveLength(0);
  });
});

describe('the utility templates', () => {
  it('puts the grace figures in the body, in order', async () => {
    await sender().sendBillingNotice({ to: '2348031234567', daysLeft: '6', endsOn: '28/08/2026' });

    expect(bodyOf()).toMatchObject({
      type: 'template',
      template: {
        name: 'rekoda_billing',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '6' },
              { type: 'text', text: '28/08/2026' },
            ],
          },
        ],
      },
    });
  });

  it('puts the retention figures in the body, in order', async () => {
    await sender().sendRetentionNotice({
      to: '2348031234567',
      daysLeft: '30',
      deletesOn: '20/09/2026',
    });

    expect(bodyOf()).toMatchObject({
      template: {
        name: 'rekoda_retention',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '30' },
              { type: 'text', text: '20/09/2026' },
            ],
          },
        ],
      },
    });
  });

  it('refuses each one when unconfigured, and sends nothing', async () => {
    await expect(
      sender({ billing: null }).sendBillingNotice({ to: '1', daysLeft: '1', endsOn: 'x' }),
    ).rejects.toThrow(/META_BILLING_TEMPLATE/);
    await expect(
      sender({ retention: null }).sendRetentionNotice({ to: '1', daysLeft: '1', deletesOn: 'x' }),
    ).rejects.toThrow(/META_RETENTION_TEMPLATE/);

    /* The retention one matters most: no template means no warning, and the
     * sweep treats an undelivered warning as a reason NOT to delete. */
    expect(requests).toHaveLength(0);
  });
});

describe('a document', () => {
  beforeEach(() => {
    respond = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url?.endsWith('/media') ? { id: 'MEDIA9' } : { messages: [{ id: 'wamid.DOC1' }] },
        ),
      );
    };
  });

  it('uploads the bytes first, then sends a message naming the id', async () => {
    await sender().sendDocument({
      to: '2348031234567',
      bytes: Buffer.from('%PDF-1.7 invoice'),
      filename: 'INV-2026-000001.pdf',
      contentType: 'application/pdf',
      caption: 'Your invoice',
    });

    expect(requests.map((r) => r.url)).toEqual(['/v21.0/PNID/media', '/v21.0/PNID/messages']);
    // The bytes go to Meta and nowhere else: a link would need the PDF on a
    // public URL, which is what the unguessable storage key exists to avoid.
    expect(requests[0]?.contentType).toMatch(/multipart\/form-data/);
    expect(requests[0]?.raw).toContain('%PDF-1.7 invoice');
    expect(requests[0]?.raw).toContain('INV-2026-000001.pdf');

    expect(bodyOf(1)).toMatchObject({
      type: 'document',
      document: { id: 'MEDIA9', filename: 'INV-2026-000001.pdf', caption: 'Your invoice' },
    });
  });

  it('omits the caption entirely rather than sending an empty one', async () => {
    await sender().sendDocument({
      to: '234803',
      bytes: Buffer.from('x'),
      filename: 'a.pdf',
      contentType: 'application/pdf',
    });
    expect(bodyOf(1).document).not.toHaveProperty('caption');
  });

  it('does not send a message when the upload returns no id', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
    };
    await expect(
      sender().sendDocument({
        to: '234803',
        bytes: Buffer.from('x'),
        filename: 'a.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow(/no id/);
    // One request, not two: nothing is announced that was never uploaded.
    expect(requests).toHaveLength(1);
  });
});

describe('fetching media a merchant sent', () => {
  it('looks up the url, then downloads it WITH the token', async () => {
    respond = (req, res) => {
      if (req.url === '/v21.0/MID7') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: `${baseUrl}/download/MID7`, mime_type: 'audio/ogg' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end(Buffer.from('OggS-voice'));
    };

    const media = await sender().fetchMedia('MID7');
    expect(media.mimeType).toBe('audio/ogg');
    expect(media.bytes.toString()).toBe('OggS-voice');

    /* The download host is a different one and the URL is not itself a
     * credential, so the token rides the second request too. */
    expect(requests).toHaveLength(2);
    expect(requests[1]?.authorization).toBe('Bearer TOKEN123');
  });

  it('fails when the lookup returns no url, rather than downloading nothing', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mime_type: 'audio/ogg' }));
    };
    await expect(sender().fetchMedia('MID8')).rejects.toThrow(/no url/);
    expect(requests).toHaveLength(1);
  });
});
