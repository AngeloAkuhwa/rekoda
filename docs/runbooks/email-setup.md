# Transactional email setup (Resend)

Rekoda sends transactional mail (today: the billing-email confirmation link;
later: debt reminders and billing notices) through a port
(`apps/api/src/email/email.port.ts`). `REKODA_EMAIL_PROVIDER` picks the sender:
`none` (default, sends nothing and says so), `mock` (in memory, refused in
production) or `resend`.

Cloudflare email routing only RECEIVES mail for role addresses. Sending needs an
authenticated sender, which is Resend here (OWN-49). Suppression and bounce
handling are Rekoda's: a permanent bounce or a spam complaint reported by Resend
is recorded (as an unkeyed SHA-256 of the address, not the address; still personal data, because a guessed address can be matched) and Rekoda will not mail
that address again. Do not use this sender for bulk mail until the owner has
seen it work on staging.

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
5. In Resend, add a webhook endpoint `https://<api-host>/webhooks/resend` for
   the events `email.bounced` and `email.complained`, and put its signing
   secret (`whsec_...`) in the same env file as `RESEND_WEBHOOK_SECRET`. With
   `resend` selected the api refuses to boot without it, because no bounce
   could be recorded.
6. Restart the api. A missing key or a malformed from-address refuses to boot,
   naming the variable; it never starts half-configured.
7. Staging check: request a billing-email confirmation from `/app/billing` with
   a Paystack TEST key and an address you own. Confirm the mail arrives, the
   link works once and the second use is refused. Then send to Resend's
   bounce test address and confirm a later request to it is refused without a
   send.

## What the code guarantees

- The Resend host is fixed in code. No variable can point production at another
  host.
- A send that fails is an error to the caller; it is never reported as sent.
- Logs carry the HTTP status or the failure kind only: never the recipient, the
  body, the provider's response or the key.
- A webhook is admitted only with a valid Svix signature over the raw body and a
  timestamp within five minutes; a replay changes nothing. Only a permanent
  bounce and a complaint suppress; transient and undetermined bounces do not.
- Known gap: if Resend accepts a message but the response is lost (a timeout),
  the billing caller treats it as not sent and voids that link, so the mail can
  arrive with a dead link. The merchant is told the send failed and can ask
  again.
- A merchant whose billing email is suppressed is told that address could not
  receive our email and to use a different one; it is not told to retry.
- Lifting a suppression (a mailbox that is fixed, or an erasure request) is an
  operator act with no UI and no API: as the database owner, delete the row
  whose `address_hash` is the SHA-256 of the trimmed, lower-cased address. The
  API role cannot update or delete these rows by design.
