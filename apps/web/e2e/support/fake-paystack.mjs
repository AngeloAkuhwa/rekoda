/**
 * A stand-in for Paystack for the browser suite, never for anything else.
 *
 * It speaks just enough of the real API for the billing journey: initialise a transaction, return
 * a hosted-page address, and answer a server-side verify. The test plays the customer: it marks
 * a reference paid here, sends the signed webhook to the API itself, and follows the link back.
 * Real Paystack is exercised on staging, not here; this proves Rekoda's side of the exchange.
 */
import { createServer } from 'node:http';

const port = Number(process.env.FAKE_PAYSTACK_PORT ?? 3199);
const transactions = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw));
  });

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
    const body = JSON.parse((await readBody(req)) || '{}');
    transactions.set(body.reference, { ...body, paid: false });
    return json(res, 200, {
      status: true,
      message: 'Authorization URL created',
      data: {
        authorization_url: `http://127.0.0.1:${port}/pay/${body.reference}`,
        access_code: `AC_${body.reference}`,
        reference: body.reference,
      },
    });
  }

  const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
  if (req.method === 'GET' && verify) {
    const t = transactions.get(decodeURIComponent(verify[1]));
    if (!t) return json(res, 404, { status: false, message: 'Transaction reference not found' });
    return json(res, 200, {
      status: true,
      message: 'Verification successful',
      data: {
        id: 4_000_000 + transactions.size,
        status: t.paid ? 'success' : 'abandoned',
        reference: t.reference,
        amount: t.amount,
        currency: t.currency,
        fees: Math.round(t.amount * 0.015),
        channel: 'card',
        paid_at: t.paid ? new Date().toISOString() : null,
        gateway_response: t.paid ? 'Successful' : 'The customer did not complete the transaction',
      },
    });
  }

  // Test control: the customer paid on the hosted page.
  const pay = url.pathname.match(/^\/__pay\/(.+)$/);
  if (req.method === 'POST' && pay) {
    const t = transactions.get(decodeURIComponent(pay[1]));
    if (!t) return json(res, 404, { ok: false });
    t.paid = true;
    return json(res, 200, {
      ok: true,
      amount: t.amount,
      currency: t.currency,
      reference: t.reference,
    });
  }

  // The hosted page the merchant is sent to: one link, back to the callback address.
  const page = url.pathname.match(/^\/pay\/(.+)$/);
  if (req.method === 'GET' && page) {
    const ref = decodeURIComponent(page[1]);
    const t = transactions.get(ref);
    res.writeHead(200, { 'content-type': 'text/html' });
    const back = t?.callback_url
      ? `${t.callback_url}?trxref=${encodeURIComponent(ref)}&reference=${encodeURIComponent(ref)}`
      : null;
    return res.end(
      `<!doctype html><title>Fake Paystack</title><h1>Fake Paystack checkout</h1>` +
        `<p data-ref>${ref}</p>` +
        (back ? `<a href="${back}">Return to merchant</a>` : '<p>No return address was given.</p>'),
    );
  }

  json(res, 404, { status: false, message: 'not found' });
}).listen(port, '127.0.0.1');
