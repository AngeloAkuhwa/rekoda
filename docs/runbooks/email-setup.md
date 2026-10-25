# Transactional email setup (Resend)

Rekoda sends transactional mail (today: the billing-email confirmation link;
later: debt reminders and billing notices) through a port
(`apps/api/src/email/email.port.ts`). `REKODA_EMAIL_PROVIDER` picks the sender:
`none` (default, sends nothing and says so), `mock` (in memory, refused in
production) or `resend`.

Cloudflare email routing only RECEIVES mail for role addresses. Sending needs an
authenticated sender, which is Resend here (OWN-49). Suppression and bounce
handling are Rekoda's and are not built yet; do not use this sender for bulk
mail until they are.

## Owner checklist

1. In Resend, add the sending domain and publish the DNS records it shows
   (SPF, DKIM) in Cloudflare DNS. Add a DMARC record (`_dmarc`, start at
   `p=none`, move to `quarantine` once reports are clean).
2. Wait until Resend shows the domain as verified.
3. Create an API key limited to sending. Do not paste it into chat, a PR or an
   issue.
4. On the host, in the api and worker env file (never in source), set:
   - `REKODA_EMAIL_PROVIDER=resend`
   - `RESEND_API_KEY=<the key>`
   - `REKODA_EMAIL_FROM=Rekoda <billing@your-domain>` (an address on the
     verified domain)
5. Restart the api. A missing key or a malformed from-address refuses to boot,
   naming the variable; it never starts half-configured.
6. Staging check: request a billing-email confirmation from `/app/billing` with
   a Paystack TEST key and an address you own. Confirm the mail arrives, the
   link works once and the second use is refused.

## What the code guarantees

- The Resend host is fixed in code. No variable can point production at another
  host.
- A send that fails is an error to the caller; it is never reported as sent.
- Logs carry the HTTP status or the failure kind only: never the recipient, the
  body, the provider's response or the key.
