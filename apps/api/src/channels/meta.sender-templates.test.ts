/**
 * The five WhatsApp template slots on the wire (OD-41(b)), against a real HTTP server: each
 * utility template's parameters in order, the billing link `{{3}}` of the grace and trial
 * templates, how a refusal is classified, and that an unset slot never becomes free text.
 * The authentication template and the rest of the adapter are in meta.sender.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MetaSender, NoSenderConfigured } from './meta.sender.js';
import { useGraphServer } from './meta.sender.fixtures.js';
import { SendFailed } from './sender.js';
import { TEMPLATE_SLOTS } from './template-slots.js';

const graph = useGraphServer();

/** The billing page `{{3}}` of the grace and trial templates (OD-41(b)). */
const LINK = 'https://staging.myrekoda.com/app/billing';

const sender = (
  opts: {
    otp?: string | null;
    billing?: string | null;
    retention?: string | null;
    document?: string | null;
    trial?: string | null;
  } = {},
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
    opts.document === undefined ? 'rekoda_document' : opts.document,
    'en',
    opts.trial === undefined ? 'rekoda_trial' : opts.trial,
    'en',
    graph.baseUrl,
  );

const bodyOf = (index = 0): Record<string, unknown> =>
  JSON.parse(graph.requests[index]!.raw) as Record<string, unknown>;

describe('the utility templates', () => {
  it('puts the grace figures in the body, in order', async () => {
    await sender().sendBillingNotice({
      to: '2348031234567',
      daysLeft: '6',
      endsOn: '28/08/2026',
      billingUrl: LINK,
    });

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
              { type: 'text', text: LINK },
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

  it('puts days left and the end date in the trial body, in order (G-109)', async () => {
    await sender().sendTrialNotice({
      to: '2348031234567',
      daysLeft: '2',
      endsOn: '16/11/2026',
      billingUrl: LINK,
    });

    expect(bodyOf()).toMatchObject({
      template: {
        name: 'rekoda_trial',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: '2' },
              { type: 'text', text: '16/11/2026' },
              { type: 'text', text: LINK },
            ],
          },
        ],
      },
    });
  });

  it('says a client error is definitely not sent and a server error is not known (OWN-47)', async () => {
    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 100 } }));
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, providerCode: 100 });

    graph.respond = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: false });

    await expect(
      sender({ trial: null }).sendTrialNotice({
        to: '1',
        daysLeft: '1',
        endsOn: 'x',
        billingUrl: LINK,
      }),
    ).rejects.toMatchObject({ notSent: true });
  });

  it('treats an expired token reported as HTTP 400 code 190, and a missing template, as sender-wide transient', async () => {
    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 190 } }));
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: true });

    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 132001 } }));
    };
    /* A missing or paused template hits every business, so it is a sender-wide outage the
     * operator fixes, not a refusal to record against each owner. */
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: true });

    graph.respond = (_req, res) => {
      res.writeHead(429);
      res.end();
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true });
  });

  it('an unconfigured sender refuses a trial notice as not sent and transient (the operator can fix it)', async () => {
    await expect(
      new NoSenderConfigured(['META_ACCESS_TOKEN']).sendTrialNotice(),
    ).rejects.toMatchObject({
      notSent: true,
      transient: true,
    });
  });

  it('treats an unrecognised 4xx as transient, and a per-recipient throttle as not an outage', async () => {
    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 999999 } }));
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: true });

    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 131056 } }));
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: false });
  });

  it('treats the spam rate limit 131048 as sender-wide, since it restricts the sending number', async () => {
    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 131048 } }));
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: true });
  });

  it('ends a stage as refused only for a recipient-scope code, whatever the HTTP status', async () => {
    for (const [status, code] of [
      [400, 131026],
      [403, 131030],
      [400, 131021],
    ] as const) {
      graph.respond = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code } }));
      };
      await expect(
        sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
      ).rejects.toMatchObject({ notSent: true, transient: false, outage: false });
    }

    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 131049 } }));
    };
    await expect(
      sender().sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: false });
  });

  it('puts what the document is and its reference in the body, in order (G-67)', async () => {
    await sender().sendDocumentNotice({
      to: '2348031234567',
      documentLabel: 'receipt',
      reference: 'RCT-2026-000002',
    });

    expect(bodyOf()).toMatchObject({
      type: 'template',
      to: '2348031234567',
      template: {
        name: 'rekoda_document',
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'receipt' },
              { type: 'text', text: 'RCT-2026-000002' },
            ],
          },
        ],
      },
    });
  });

  it('refuses each one when unconfigured, and sends nothing', async () => {
    await expect(
      sender({ document: null }).sendDocumentNotice({
        to: '1',
        documentLabel: 'receipt',
        reference: 'x',
      }),
    ).rejects.toThrow(/META_DOCUMENT_TEMPLATE/);
    await expect(
      sender({ billing: null }).sendBillingNotice({
        to: '1',
        daysLeft: '1',
        endsOn: 'x',
        billingUrl: LINK,
      }),
    ).rejects.toThrow(/META_BILLING_TEMPLATE/);
    await expect(
      sender({ retention: null }).sendRetentionNotice({ to: '1', daysLeft: '1', deletesOn: 'x' }),
    ).rejects.toThrow(/META_RETENTION_TEMPLATE/);
    await expect(
      sender({ trial: null }).sendTrialNotice({
        to: '1',
        daysLeft: '1',
        endsOn: 'x',
        billingUrl: LINK,
      }),
    ).rejects.toThrow(/META_TRIAL_TEMPLATE/);
    /* An unconfigured trial template is a fixable condition: it must not burn a reminder stage. */
    await expect(
      sender({ trial: null }).sendTrialNotice({
        to: '1',
        daysLeft: '1',
        endsOn: 'x',
        billingUrl: LINK,
      }),
    ).rejects.toMatchObject({ notSent: true, transient: true, outage: true });

    /* The retention one matters most: no template means no warning, and the
     * sweep treats an undelivered warning as a reason NOT to delete. */
    expect(graph.requests).toHaveLength(0);
  });
});

/* OD-41(b): the five slots on the wire. Each test sends through the name and language the
 * environment configured, with the parameters `TEMPLATE_SLOTS` declares, in that order. */
describe('the five template slots (OD-41(b))', () => {
  const named = () =>
    new MetaSender(
      'TOKEN123',
      'PNID',
      'v21.0',
      2_000,
      'rekoda_login_otp',
      'en_GB',
      'rekoda_billing_grace_notice',
      'en',
      'rekoda_retention_notice',
      'fr',
      'rekoda_document_ready',
      'en_US',
      'rekoda_trial_ending',
      'en',
      graph.baseUrl,
    );

  const templateOf = (index = 0) =>
    bodyOf(index)['template'] as {
      name: string;
      language: { code: string };
      components: {
        type: string;
        sub_type?: string;
        parameters: { type: string; text: string }[];
      }[];
    };

  it('sends each slot through its configured name and language, with the declared parameters in order', async () => {
    const s = named();
    await s.sendAuthCode({ to: '1', code: '123456' });
    await s.sendBillingNotice({ to: '1', daysLeft: '5', endsOn: '12/11/2026', billingUrl: LINK });
    await s.sendRetentionNotice({ to: '1', daysLeft: '30', deletesOn: '07/12/2026' });
    await s.sendDocumentNotice({ to: '1', documentLabel: 'receipt', reference: 'RCT-0001' });
    await s.sendTrialNotice({ to: '1', daysLeft: '7', endsOn: '14/11/2026', billingUrl: LINK });

    const values: Record<string, string> = {
      code: '123456',
      daysLeft: '',
      endsOn: '',
      deletesOn: '07/12/2026',
      billingUrl: LINK,
      documentLabel: 'receipt',
      reference: 'RCT-0001',
    };
    const daysLeft = ['', '5', '30', '', '7'];
    const endsOn = ['', '12/11/2026', '', '', '14/11/2026'];
    const locales = ['en_GB', 'en', 'fr', 'en_US', 'en'];

    TEMPLATE_SLOTS.forEach((slot, i) => {
      const t = templateOf(i);
      expect(t.name).toBe(slot.agreedName);
      expect(t.language.code).toBe(locales[i]);
      const body = t.components.find((c) => c.type === 'body')!;
      expect(body.parameters.map((p) => p.type)).toEqual(slot.body.map(() => 'text'));
      expect(body.parameters.map((p) => p.text)).toEqual(
        slot.body.map((p) =>
          p === 'daysLeft' ? daysLeft[i] : p === 'endsOn' ? endsOn[i] : values[p],
        ),
      );
      const button = t.components.find((c) => c.type === 'button');
      if (slot.button) {
        expect(button).toMatchObject({ sub_type: 'url', index: '0' });
        expect(button!.parameters).toEqual([{ type: 'text', text: values[slot.button] }]);
      } else {
        expect(button).toBeUndefined();
      }
    });
    expect(graph.requests).toHaveLength(5);
  });

  it('carries the billing page as {{3}} of the trial template at 7, 2 and 1 days left', async () => {
    const s = named();
    for (const days of ['7', '2', '1']) {
      await s.sendTrialNotice({ to: '1', daysLeft: days, endsOn: '14/11/2026', billingUrl: LINK });
    }
    expect([0, 1, 2].map((i) => templateOf(i).components[0]!.parameters)).toEqual(
      ['7', '2', '1'].map((days) => [
        { type: 'text', text: days },
        { type: 'text', text: '14/11/2026' },
        { type: 'text', text: 'https://staging.myrekoda.com/app/billing' },
      ]),
    );
  });

  it('refuses a grace or trial notice with no billing page as not sent, transient, and sends nothing', async () => {
    for (const attempt of [
      () => named().sendBillingNotice({ to: '1', daysLeft: '5', endsOn: 'x', billingUrl: null }),
      () => named().sendTrialNotice({ to: '1', daysLeft: '5', endsOn: 'x', billingUrl: null }),
      () => named().sendTrialNotice({ to: '1', daysLeft: '5', endsOn: 'x', billingUrl: '' }),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SendFailed);
      expect(error).toMatchObject({ notSent: true, transient: true });
      expect((error as SendFailed).message).toMatch(/REKODA_WEB_URL/);
    }
    expect(graph.requests).toHaveLength(0);
  });

  it('never falls back to a free-form text when a slot is unset', async () => {
    const unset = new MetaSender(
      'TOKEN123',
      'PNID',
      'v21.0',
      2_000,
      null,
      'en',
      null,
      'en',
      null,
      'en',
      null,
      'en',
      null,
      'en',
      graph.baseUrl,
    );
    for (const attempt of [
      () => unset.sendAuthCode({ to: '1', code: '1' }),
      () => unset.sendBillingNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
      () => unset.sendRetentionNotice({ to: '1', daysLeft: '1', deletesOn: 'x' }),
      () => unset.sendDocumentNotice({ to: '1', documentLabel: 'receipt', reference: 'R' }),
      () => unset.sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(SendFailed);
    }
    // Nothing at all reached Meta: no template, and no `type: text` substitute.
    expect(graph.requests).toHaveLength(0);
  });

  it('reports a parameter mismatch Meta refuses (132000) as definitely not sent', async () => {
    graph.respond = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 132000, message: 'Number of parameters does not match' } }),
      );
    };
    const error = await named()
      .sendTrialNotice({ to: '1', daysLeft: '1', endsOn: 'x', billingUrl: LINK })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ notSent: true, providerCode: 132000 });
    // Meta's own message text never travels on the error (it can echo the request).
    expect((error as SendFailed).message).not.toMatch(/Number of parameters/);
  });
});
