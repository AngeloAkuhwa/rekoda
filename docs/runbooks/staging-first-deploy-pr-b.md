# First staging deploy of PR B (#432): configuration, backups, deployment and acceptance

Revision 3, 14 Nov 2026 (revision 2 was `aba7754` on `angelo/magical-bell-hvwoy6`). **The procedure for the first
staging deploy of PR B and the staging acceptance that follows it.** Nothing here has been applied to any host by
engineering. No secret value appears in this document. Production is out of scope. Staging only, Paystack TEST mode
only.

## 0. How staging is configured, and who checks what

**Owner decision (14 Nov 2026):**

- Every staging **application** setting (database URLs, keys, Paystack, Meta, Resend, OIDC, flags) is entered **by
  hand on the Hetzner host**, in `/opt/rekoda/.env` (mode 600) and `/etc/rekoda/backup.env` (root, 0600). None of it
  goes into GitHub.
- GitHub keeps only what the existing deploy needs to reach the host: the `staging` environment's
  `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_PRIVATE_KEY` and `STAGING_KNOWN_HOSTS`. CI enforces that the workflow
  reads no other secret (`scripts/check-staging-deploy.mjs`, `ALLOWED_SECRETS`).
- **The automatic flow stays:** a merge to `main` → CI → Deploy staging → `scripts/deploy-staging.sh` on the host.

| Check                                                                                                                                                            | Who                                                                 | How                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Code, tests, CI on the PR head; independent review                                                                                                               | Claude                                                              | before merge; reported on the PR                                                 |
| `.env` holds a Paystack **TEST** key on one plain line and no `REKODA_PAYSTACK_PLATFORM_CONFIRMED=1`; a value exported in the deploy shell never reaches compose | `deploy-staging.sh` (automatic, every staging deploy), then Angelo  | the deploy refuses before building anything; Angelo still runs P5 before merging |
| `.env` holds the settlement and operator credentials (right roles), OIDC issuer, JWKS, the billing audience (different from the API's) and `VAULT_KEY`           | `deploy-staging.sh` (automatic, for a release carrying 0202 / 0217) | refuses before anything is stopped                                               |
| Pre-start database smoke after migrating                                                                                                                         | `deploy-staging.sh` (automatic)                                     | must print `t`, or nothing starts                                                |
| `/health` names the release                                                                                                                                      | `deploy-staging.sh` and the workflow (automatic)                    | —                                                                                |
| Hetzner snapshot, resize, firewall; Cloudflare DNS and SSL                                                                                                       | **Angelo**                                                          | §2, §3, P1 to P2                                                                 |
| Entering every `.env` and `backup.env` value                                                                                                                     | **Angelo**                                                          | §4, P4, P8                                                                       |
| R2 bucket, token, lock, lifecycle; first backup and restore drill; timer                                                                                         | **Angelo**                                                          | §1, P4, P7, D9 to D10                                                            |
| Pending charges list, release preflight, staging tools set-up                                                                                                    | **Angelo**                                                          | P6, D6, D7                                                                       |
| Read-only check (now also asks the **settlement** container for its Paystack key)                                                                                | **Angelo** runs it; the script judges                               | D8                                                                               |
| Website, WhatsApp, email, payments, and every acceptance test                                                                                                    | **Angelo**                                                          | §9                                                                               |
| Docker disk cleanup                                                                                                                                              | **Angelo**, only when needed                                        | `docs/runbooks/deploy.md`, "Docker cleanup by hand (staging)"                    |

Evidence for this document:

| Fact                                                                                                                                                                | Evidence                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Staging runs `main` `58e6834`, 193 migrations (0000 to 0192)                                                                                                        | Deploy staging run #184, 8 Nov 2026 (job log) |
| Staging's `.env`, Cloudflare zone, Hetzner project and GitHub settings were **not** inspected                                                                       | The engineering session cannot reach the host |
| The backup and restore scripts were exercised end to end against an S3-compatible server (not R2 itself), with AWS CLI v2.40.3 and a database migrated through 0223 | §1.3                                          |
| Settlement and operator memory, boot refusals and the 401 were measured by starting the real processes in production mode                                           | §3, §4                                        |

## 1. Cloudflare R2 for off-box PostgreSQL backups

### 1.1 Verdict

**The existing scripts work with R2 unchanged. No code change is needed.** They use only `aws s3 cp`, `aws s3 ls`
and `aws s3 rm` against `--endpoint-url`. Backup object names are unique (`rekoda-<UTC stamp>-<pid>.dump.enc`), so
nothing is ever overwritten. Two R2 facts change the runbook, not the code:

1. **R2 has no S3 versioning and no S3 Object Lock API.** Cloudflare's S3 compatibility table lists
   `PutBucketVersioning` and `PutObjectLockConfiguration` as unsupported. R2's own feature is **bucket locks**:
   rules by prefix that block delete **and** overwrite for an age, until a date, or indefinitely. Lifecycle rules
   are supported, and a lock overrides a lifecycle deletion.
2. **R2 API tokens cannot be limited to a key prefix or suffix.** Permissions are Admin Read & Write, Admin Read
   only, Object Read & Write, and Object Read only. The two Object permissions can be scoped to chosen buckets,
   nothing finer. **The ".pending-only delete" restriction in the old runbook cannot be expressed on R2.** Object
   Read & Write includes delete for the whole bucket.

### 1.2 Protection strategy (replaces "versioning or object lock")

- **A dedicated bucket**, e.g. `rekoda-staging-backups`. Never the documents bucket (`R2_BUCKET`).
- **A dedicated token:** _Object Read & Write_, scoped to that one bucket only. It is an Account API token, so it
  survives a user leaving. Use it only in `/etc/rekoda/backup.env`. **Never reuse the application's `R2_*` token**,
  and never put backup credentials in `/opt/rekoda/.env`, which reaches the api and worker.
- **A bucket lock rule** as the deletion guard. Dashboard: R2 → bucket → Settings → Bucket lock rules → Add rule:
  name `retain-30d`, prefix `staging/`, retention **Age 30 days**. For 30 days nobody can delete or overwrite a
  backup: not the host, not a stolen backup token, not a lifecycle rule.
- **A lifecycle rule** for cost and tidiness. R2 → bucket → Settings → Object lifecycle rules: prefix `staging/`,
  delete objects after **90 days**; abort incomplete multipart uploads after 1 day. The lock wins until day 30.
  (The runbook's warning still applies: expiry keeps running if backups stop. The weekly check in §1.6 is the
  control.)
- **Expected side effect of the lock:** the script stages `<name>.pending`, reads it back, publishes, then deletes
  the `.pending` copy. Under the lock that delete is refused (HTTP 409 `ObjectLockedByBucketPolicy`). The script
  tolerates it (`|| true`), the run still succeeds, and the journal shows one 409 line each night. The `.pending`
  copy stays until the lock and lifecycle expire it, roughly doubling storage (a small staging dump costs pennies).
  Listing and the drill never select `.pending` objects. Proven in §1.3, case 3.
- **The admin token** that edits lock and lifecycle rules stays in your Cloudflare login. It never goes on the host.
- **Location:** create the bucket without a jurisdiction, so the endpoint is the default one below. A location hint
  of Western Europe sits near the Hetzner server. (For production, decide with counsel whether merchant data may sit
  in an EU/US bucket under the NDPA; staging holds test data only.)

### 1.3 What was actually tested (13 Nov 2026, this session)

Test bed: PostgreSQL 16 (`postgres:16-alpine`) migrated with the real migrations **0000 to 0223**, then the real
`provision.js` setting all four runtime passwords from four distinct URLs. It was seeded through the application's
own sale and payment code: 3 businesses, 12 ledger entries, 3 invoices. AWS CLI **v2.40.3**. An S3-compatible server
stood in for R2. The unmodified `scripts/backup-db.sh` and `scripts/restore-drill.sh` from `06035e6` were run with
the exact `backup.env` shape in §1.4.

| #   | Case                                                                                              | Result                                                                                           |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Backup: dump, encrypt, upload `.pending`, read back, compare SHA-256, publish, delete `.pending`  | `backup: ok … 819984 bytes`, exit 0; only `.dump.enc` and `.sha256` remain                       |
| 2   | Restore drill: newest object, checksum, decrypt, restore into a throwaway container, ledger check | `businesses=3 ledger_entries=12 invoices=3 unbalanced_businesses=0`, `PASS`, container removed   |
| 3   | Every delete refused as an R2 bucket lock refuses it (409 `ObjectLockedByBucketPolicy`)           | Backup still `ok`, exit 0; `.pending` left beside the published object; a later drill unaffected |
| 4   | 25 MB object (the CLI switches to a multipart upload above 8 MB)                                  | Uploaded multipart, read back, checksum equal, `ok`                                              |
| 5   | Tampered object                                                                                   | Drill refuses: `checksum mismatch`, exit 1                                                       |
| 6   | Wrong passphrase                                                                                  | Drill refuses: `decryption failed`                                                               |
| 7   | Drill of a named object (`DRILL_OBJECT`)                                                          | `PASS`                                                                                           |

**Not proven here:** the behaviour of Cloudflare's own endpoint (the session cannot reach R2), and the systemd timer.
§1.5 is therefore the real proof, and it must pass on the host before the deploy.

**Checksums.** Since AWS CLI 2.23 the CLI adds its own checksum headers by default. R2 supports CRC64NVME only as a
whole-object checksum, and CRC32/CRC32C/SHA only as per-part (composite) checksums on multipart uploads. Setting both
`AWS_REQUEST_CHECKSUM_CALCULATION=when_required` and `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` removes that
variable. The script's own SHA-256 read-back is the integrity check that matters, and case 4 shows it works on
multipart. Use a current AWS CLI v2. Some third-party reports say 2.23.0 to 2.23.4 ignored the setting for `s3 cp`,
so avoid those versions.

### 1.4 Files on the host (root-owned)

```bash
sudo install -d -m 700 -o root -g root /etc/rekoda
sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/rekoda/backup.pass'   # 64 hex chars on one line
sudo chmod 600 /etc/rekoda/backup.pass
```

Put a copy of `backup.pass` in your password manager **now**. Without it no backup can be restored, ever.

`/etc/rekoda/backup.env` (mode **0600**, owner root). systemd `EnvironmentFile` syntax: one `NAME=value` per line,
no `export`, no quotes needed, no `$`:

```
BACKUP_DEST=s3://rekoda-staging-backups/staging
BACKUP_S3_ENDPOINT=https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
BACKUP_PASSPHRASE_FILE=/etc/rekoda/backup.pass
AWS_ACCESS_KEY_ID=<backup token Access Key ID>
AWS_SECRET_ACCESS_KEY=<backup token Secret Access Key>
AWS_DEFAULT_REGION=auto
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

Leave `BACKUP_DUMP_CMD` unset (the default dumps the compose `postgres` as `rekoda_owner`). `BACKUP_RETAIN_DAYS`
does not apply to `s3://`. Tools on the host: AWS CLI v2 (`aws --version`), `openssl`, `sha256sum`, docker.

### 1.5 First backup and drill (must pass before the deploy)

```bash
sudo cp /opt/rekoda/deploy/systemd/rekoda-backup.service /opt/rekoda/deploy/systemd/rekoda-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start rekoda-backup.service           # one run now; blocks until it finishes
sudo systemctl status rekoda-backup.service --no-pager   # must show: status=0/SUCCESS
sudo journalctl -u rekoda-backup.service -n 20 --no-pager   # must end: backup: ok rekoda-<stamp>-<pid>.dump.enc <bytes> bytes
```

Restore drill, as root, with the same variables (it starts a throwaway `postgres:16-alpine` and removes it):

```bash
sudo bash -c 'set -a; . /etc/rekoda/backup.env; set +a; cd /opt/rekoda && bash scripts/restore-drill.sh'
# must end:  restore-drill: object=<the object above> ... unbalanced_businesses=0
#            restore-drill: PASS
```

Then confirm in the R2 dashboard that the object, its `.sha256` and (with the lock on) its `.pending` exist under
`staging/`. Record the date, object name, size, `restore_seconds`, counts and PASS in `docs/runbooks/backup-restore.md`
(drill log), and replace that runbook's honesty note with the bucket name and first-upload date.

Notes:

- The drill refuses a database with no ledger entries. Staging must hold at least one recorded sale.
- On a 4 GB host the drill's extra Postgres competes for memory. Run it when no build is running.

### 1.6 Enable and verify the nightly timer

```bash
sudo systemctl enable --now rekoda-backup.timer
systemctl list-timers rekoda-backup.timer --no-pager   # NEXT shows the coming 01:00 UTC (02:00 WAT)
```

The next morning: `systemctl status rekoda-backup.service` shows a successful run at about 01:00 UTC, and R2 shows a
new object. Weekly, until an alert exists: the same two checks. Drill monthly and before any migration that touches
financial tables.

## 2. Hetzner and Cloudflare networking

### 2.1 Proxied or DNS-only

Both work with the code; they need different settings. **Change one thing at a time:** keep staging in its current
mode for the PR #432 deploy, and make the Cloudflare change as its own step (before or after), never inside the
deploy window. Check the current mode first: Cloudflare → DNS → the `staging` and `staging-api` records (orange
cloud = proxied), and on the host `grep -c '^REKODA_EDGE_PROXIES=.' /opt/rekoda/.env` (1 means a value is set).

|                        | DNS-only (grey)                               | Proxied (orange), recommended target                                                                                     |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `REKODA_EDGE_PROXIES`  | empty                                         | Cloudflare's IPv4 list (§2.2)                                                                                            |
| SSL/TLS mode           | n/a                                           | **Full (strict)**                                                                                                        |
| "Always Use HTTPS"     | n/a                                           | **Off** (Caddy redirects itself; ACME challenges arrive over plain HTTP)                                                 |
| Hetzner inbound 80/443 | any source                                    | Cloudflare ranges only (§2.3)                                                                                            |
| Certificates           | Let's Encrypt connects to the server directly | Let's Encrypt's HTTP-01 request reaches Cloudflare, which forwards it to the server on port 80 from a Cloudflare address |

**Why it matters for acceptance:** if the records are proxied but `REKODA_EDGE_PROXIES` is empty, Caddy sees every
visitor as a Cloudflare address. All testers then share a handful of rate-limit buckets (60 requests a minute per
address by default) and hit 429s.

Proxied also needs these Cloudflare settings:

- **Bot Fight Mode off** for this zone, and no WAF or "Under Attack" challenge on `staging-api`. A challenge answered
  to Meta, Paystack or Resend silently breaks webhooks.
- No AAAA records (A only, as the runbook says).
- No caching rules on `staging-api` (Cloudflare does not cache JSON by default; do not add any).

### 2.2 `REKODA_EDGE_PROXIES`

When proxied, set the IPv4 list on one line, space-separated (Cloudflare's published list on 13 Nov 2026):

```
REKODA_EDGE_PROXIES=173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22
```

- Checked in this session with the release's own `dist/edge-check.js`: accepted (exit 0), with or without the IPv6
  list appended. `0.0.0.0/0` and `private_ranges` are refused.
- IPv6 ranges are not needed: with A records only, Cloudflare reaches the server over IPv4.
- **Apply:** edit `.env`, then `dc up -d --wait caddy`. That recreates Caddy with the new value and re-runs
  edge-check; certificates live in the `caddy_data` volume and survive.
- Re-check Cloudflare's list (cloudflare.com/ips-v4) monthly; a new range is a silent rate-limit problem.

### 2.3 Firewall (Hetzner Cloud Firewall, plus `ufw` on the host)

| Direction | Port            | Source                                                | Why                                                                                                                                                                                                               |
| --------- | --------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In        | TCP 22          | **Any** (key-only SSH)                                | The GitHub Actions deploy connects over SSH from GitHub's changing runner addresses. Restricting 22 to your own IP **breaks the automatic deploy**. Keep `PasswordAuthentication no`; optionally fail2ban         |
| In        | TCP 80          | Any (DNS-only), or the Cloudflare IPv4 list (proxied) | HTTP→HTTPS redirect **and certificate renewal**. Never close 80                                                                                                                                                   |
| In        | TCP 443         | as 80                                                 | HTTPS                                                                                                                                                                                                             |
| In        | UDP 443         | as 80                                                 | HTTP/3, direct visitors only (harmless to keep)                                                                                                                                                                   |
| In        | everything else | none                                                  | Postgres 5432 and the app ports 3000 to 3003 are never published; compose keeps them on internal Docker networks                                                                                                  |
| Out       | all             | —                                                     | **Add no outbound rules.** On a Hetzner Cloud Firewall, adding any outbound rule blocks every other destination. The stack needs Paystack, Meta, Resend, Anthropic, R2, Let's Encrypt, Docker Hub, npm and GitHub |

**Certificate safety:**

- Restricting 80/443 to Cloudflare does **not** break issuance or renewal _while the records are proxied_. Caddy
  tries TLS-ALPN-01 (fails through a proxy) and HTTP-01 (works through Cloudflare on port 80).
- It **does** break renewal if someone later switches the records back to DNS-only. Let's Encrypt would then
  connect directly and be blocked. If you ever go back to DNS-only, reopen 80/443 to Any first.
- Order of changes, each verified before the next:
  1. Confirm the site loads with valid certificates.
  2. Set `REKODA_EDGE_PROXIES` and recreate Caddy.
  3. Proxy the two records, SSL Full (strict), Always Use HTTPS off.
  4. Test the site, the API `/health` and a Meta, Paystack and Resend test webhook.
  5. Only then restrict the firewall's 80/443 to Cloudflare.
  6. Run `curl -sI http://staging.myrekoda.com/.well-known/acme-challenge/test`: it should reach Caddy (a 404 from
     the origin, not a Cloudflare error).

Docker publishes ports through its own iptables rules, which bypass `ufw`. The Hetzner Cloud Firewall sits outside
the server and is therefore the control that actually holds for 80/443.

## 3. Server resources: 8 GB is required in practice, not just preferred

| Measurement                                                | Value                                                | Source                                  |
| ---------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| Memory available after each image build, old stack running | 1,093,452 KiB (api build), 1,101,384 KiB (web build) | Deploy staging run #184 log, 8 Nov 2026 |
| The deploy's floor before the web build                    | 1,048,576 KiB (1 GiB), read from `MemAvailable`      | `scripts/deploy-staging.sh`             |
| New `settlement` process                                   | 165 MB resident, 175 MB peak                         | measured here, production mode          |
| New `operator` process                                     | 162 MB resident, 163 MB peak                         | measured here, production mode          |

- **This** deploy fits: the two new processes do not exist yet while it builds.
- **Every later deploy** builds with them running. About 330 MB less leaves roughly 0.75 GiB at the floor check, so
  the deploy script refuses to build ("only … KiB of memory available").
- **Swap does not help.** The floor reads `MemAvailable`, which does not count swap, and the floor can only be
  raised, never lowered.
- Staying on 4 GB would mean stopping services by hand before every deploy. The restore drill's extra Postgres and
  the web build's 1.5 GB Node heap make it worse.

**Recommendation:** rescale to an 8 GB type (ADR 0006 planned CPX31: 4 vCPU / 8 GB), **before** the deploy window.
Hetzner → Server → Rescale. The server must be powered off, so expect a few minutes of downtime. Choose "CPU and RAM
only" to keep the disk size, so you can scale back down. **Take the snapshot first.** Then add a 2 GiB swap file
anyway, as the runbook's safety net against an out-of-memory kill:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

If you must stay on 4 GB for now: 2 GiB swap is the minimum. Expect slow builds and possible stalls under memory
pressure, and stop `operator` and `settlement` before each later deploy's build (the deploy script does not).

## 4. Final environment list

All values go in `/opt/rekoda/.env` (mode 600) unless stated otherwise. **Compose decides what each process
receives:**

- `api`, `worker` and `migrate` load the whole `.env`.
- **`settlement` and `operator` never load `.env`.** They receive only the names listed for them in
  `docker-compose.prod.yml`, so a forbidden secret in `.env` cannot reach them.

The only ways to break that are editing the compose file, or exporting one of _their_ listed names in the shell
that runs compose. Run compose from a clean login shell.

Verified in this session: settlement given `META_APP_SECRET` refuses to start ("must not be given META_APP_SECRET");
operator with equal audiences refuses to start.

### 4.1 Must be added (new in PR #432)

| Variable                         | Receives it                                                | Value / format                                                                                               | Secret |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| `SETTLEMENT_DATABASE_URL`        | settlement, migrate (compose blanks it for api and worker) | `postgres://rekoda_settlement:<new hex password>@postgres:5432/rekoda`                                       | yes    |
| `OPERATOR_DATABASE_URL`          | operator, migrate (blanked for api and worker)             | `postgres://rekoda_billing_operator:<new hex password>@postgres:5432/rekoda`                                 | yes    |
| `OPERATOR_BILLING_OIDC_AUDIENCE` | operator                                                   | an audience your identity provider issues **only** for plan changes; different from `OPERATOR_OIDC_AUDIENCE` | no     |

The two passwords: `openssl rand -hex 32` each, and different from each other and from the `rekoda_app` and
`rekoda_worker` passwords. `provision.js` refuses a shared password, a wrong role name or a different host. This was
rehearsed here: "runtime role passwords set: rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator".

### 4.2 Must exist already, now also feeding the new processes (verify)

| Variable                                                                                                      | Receives it                                    | Check                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_KEY`                                                                                                   | api, worker, **settlement**                    | present, 64 hex; **never change it** (fingerprint-enrolled; settlement opens sealed Paystack events with it)                                                                                                                                       |
| `OPERATOR_OIDC_ISSUER`                                                                                        | api, worker, **operator**                      | public https                                                                                                                                                                                                                                       |
| `OPERATOR_OIDC_JWKS_URL`                                                                                      | api, worker, **operator**                      | public https                                                                                                                                                                                                                                       |
| `OPERATOR_OIDC_AUDIENCE`                                                                                      | api, worker; operator only compares it         | present; differs from the billing audience                                                                                                                                                                                                         |
| `PAYSTACK_SECRET_KEY`                                                                                         | api, worker, **settlement** (never operator)   | `sk_test_…`. The api verifies Paystack's webhook signatures with it and settlement verifies payments with it. Settlement boots and reports healthy without it, so the staging deploy now refuses a non-TEST key; still check it (§7 P5, §8 D4, D7) |
| `DATABASE_URL`, `WORKER_DATABASE_URL`                                                                         | api, worker, migrate                           | roles `rekoda_app`, `rekoda_worker`                                                                                                                                                                                                                |
| `MATCH_KEY`, `OTP_PEPPER`, `REKODA_API_SECRET`, `CONNECTION_KEY`                                              | api, worker only                               | present (`CONNECTION_KEY` optional)                                                                                                                                                                                                                |
| `REKODA_API_PUBLIC_URL`, `NEXT_PUBLIC_SITE_URL`, `REKODA_WEB_URL`, `REKODA_ACME_EMAIL`, `REKODA_CORS_ORIGINS` | caddy, web, api, worker as compose routes them | `https://staging-api.myrekoda.com`, `https://staging.myrekoda.com` (twice), your mailbox, and a CORS list that includes `https://staging.myrekoda.com` (the default is localhost)                                                                  |

### 4.3 Meta / WhatsApp (api and worker only; settlement and operator refuse them)

| Variable                                             | Value                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_SECRET`                                    | App Dashboard → Settings → Basic → App secret (≥16 chars)                                                                           |
| `META_VERIFY_TOKEN`                                  | a string you generate (≥16), typed identically into the webhook config                                                              |
| `META_ACCESS_TOKEN`                                  | a **System User permanent token** with `whatsapp_business_messaging` and `whatsapp_business_management`, not the 24-hour test token |
| `META_PHONE_NUMBER_ID`                               | WhatsApp → API Setup → Phone number ID                                                                                              |
| `META_OTP_TEMPLATE` / `META_OTP_TEMPLATE_LOCALE`     | `rekoda_login_otp` / as WhatsApp Manager shows it                                                                                   |
| `META_BILLING_TEMPLATE` / `_LOCALE`                  | `rekoda_billing_grace_notice`                                                                                                       |
| `META_DOCUMENT_TEMPLATE` / `_LOCALE`                 | `rekoda_document_ready`                                                                                                             |
| `META_TRIAL_TEMPLATE` / `META_TRIAL_TEMPLATE_LOCALE` | `rekoda_trial_ending` / `en`                                                                                                        |
| `META_RETENTION_TEMPLATE` / `_LOCALE`                | `rekoda_retention_notice` (optional; needed for the retention test in §9)                                                           |

- The code reads **no** App ID and **no** WABA ID.
- Set a template name only once it shows **Approved** in WhatsApp Manager.
- Meta dashboard: Webhooks → callback `https://staging-api.myrekoda.com/webhooks/meta`, verify token =
  `META_VERIFY_TOKEN`, subscribe field **messages** (it carries delivery statuses too).
- Add every tester phone to the test number's allowed recipients.

### 4.4 Resend (api and worker only)

| Variable                | Value                                |
| ----------------------- | ------------------------------------ |
| `REKODA_EMAIL_PROVIDER` | `resend`                             |
| `RESEND_API_KEY`        | a sending-only key                   |
| `REKODA_EMAIL_FROM`     | `Rekoda <billing@<verified domain>>` |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` of the webhook below       |

Resend dashboard:

- Domain shows **Verified**: SPF and DKIM records from Resend added in Cloudflare DNS (DNS-only, never proxied),
  plus `_dmarc` TXT `v=DMARC1; p=none`.
- Webhook `https://staging-api.myrekoda.com/webhooks/resend`, events `email.bounced` and `email.complained`.

### 4.5 Paystack TEST dashboard

- Settings → API Keys & Webhooks → **Test** Webhook URL: `https://staging-api.myrekoda.com/webhooks/paystack`.
- No Paystack public key is used anywhere in the code (checkout redirects to Paystack's hosted page).
- `REKODA_PAYSTACK_PLATFORM_CONFIRMED` must be **absent**.

### 4.6 Flags and settings

| Variable                                                                                                                    | Receives it       | Value                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `REKODA_STAGING_TOOLS`                                                                                                      | api, worker       | add `1` **after** the deploy is healthy (§8 D12); never in compose                          |
| `REKODA_ANNUAL_BILLING`                                                                                                     | api, worker       | `1` for the yearly steps                                                                    |
| `REKODA_CUSTOMER_REMINDERS`                                                                                                 | api, worker       | absent or `0` until the billing walkthrough is done, then `1`                               |
| `REKODA_ALERT_WEBHOOK_URL`                                                                                                  | worker            | recommended: an https chat incoming-webhook                                                 |
| `REKODA_EDGE_PROXIES`                                                                                                       | caddy, edge-check | §2.2 (only when proxied)                                                                    |
| `REKODA_PLAN_CATALOGUE_READS`, every `REKODA_COMMAND_*`                                                                     | —                 | **absent**                                                                                  |
| `REKODA_OPERATOR_SECRET`, `REKODA_REVEAL_OTP`, `REKODA_LOCAL_STORAGE`, `PAYSTACK_BASE_URL`, `MONO_BASE_URL`, `REKODA_E2E_*` | —                 | **absent** (refused or forbidden)                                                           |
| `ANTHROPIC_API_KEY`                                                                                                         | api, worker       | needed for WhatsApp interpretation tests                                                    |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`                                                    | api, worker       | all four or none; documents bucket and token, **separate from the backup bucket and token** |

### 4.7 Outside `.env`

| Setting                                                                                                                                          | Where                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `/etc/rekoda/backup.env`, `/etc/rekoda/backup.pass`                                                                                              | host, root, 0600 (§1.4)                       |
| GitHub: nothing to add (optional approval gate)                                                                                                  | §5                                            |
| Identity provider: tokens for the **billing** audience with `ops:billing`, and API-audience tokens with `ops:read`, `ops:payment`, `ops:staging` | your IdP                                      |
| `staging_environment` marker row                                                                                                                 | database, as owner, after the deploy (§8 D12) |

## 5. GitHub

**Nothing to add in GitHub.** Do not put any application value there. The four existing `staging` environment
secrets stay as they are; the automatic deploy keeps working.

Because the deploy starts automatically after the merge, **finish every pre-merge step (§7) first.** The deploy
checks only some values before it builds or stops anything ("nothing has been changed"): the Paystack TEST key (one
plain line, no `REKODA_PAYSTACK_PLATFORM_CONFIRMED=1`) on every deploy, and, for this release, the settlement and
operator credentials and their roles, the OIDC issuer, JWKS and billing audience (different from the API's) and that
`VAULT_KEY` is present. **Everything else** (`META_*`, `RESEND_*`, `MATCH_KEY`, `OTP_PEPPER`, a malformed `VAULT_KEY`,
the OIDC values' format) is checked only when the api or worker boots, which is **after** the processes are stopped and
migrations 0193 to 0223 are applied: a mistake there leaves staging down until `.env` is fixed and the deploy is run
again (fix forward; no rollback past 0196 without a restore). P8 and P9 are the only check for those values. When the
deploy does refuse early, fix `.env` and redeploy: Actions → Deploy staging → Run workflow (branch `main`, SHA
blank).

**Optional, your choice:** a one-time approval gate for this first deploy. Settings → Environments → `staging` →
Required reviewers: add yourself; leave "Prevent self-review" unticked; untick "Allow administrators to bypass". The
run then waits for "Approve and deploy". This changes no secret and no workflow file. Remove the rule afterwards to
return to fully automatic deploys. Not required by this procedure.

## 6. Acceptance-test gaps: procedures and limits

### 6.1 Dead-job recovery (OWN-73 / OWN-76): a safe, repeatable procedure

**Mechanism:** a settlement payment job whose Paystack verify cannot reach Paystack throws and is retried. Retries
back off at about 2, 4, 8, 16 and 32 seconds, with at least 5 attempts. Then the job is marked dead and its
dead-job record is written in the same transaction. This simulates a real provider outage for the settlement
process only, by removing its route to the internet. **No SQL, no code, no data edited.** The api, worker, database,
webhooks and other users are unaffected; only settlement's outbound calls fail during the window.

**Status: BLOCKED / PENDING the owner's explicit written approval.** OWN-77 forbids raw SQL and improvised host
changes. This is a host-level network change, reversible in one command and recorded in the evidence. It is **not**
run, by engineering or anyone, until Angelo approves it in writing (a new OWN entry). Until then this test is reported
BLOCKED, never PASS.

Procedure (one fresh test business; nobody else paying on staging during the window):

1. Record `dc ps settlement` and `GET /v1/ops/exceptions` (token with `ops:read`), both before.
2. `docker network disconnect rekoda-prod_settlement-egress rekoda-prod-settlement-1` (the database stays reachable).
3. The merchant buys a pack with a Paystack TEST card. The webhook arrives; the api records it; settlement claims
   the job, fails to verify, and retries.
4. Within about 2 minutes, `dc logs settlement` shows the failures, and `GET /v1/ops/exceptions` lists the dead
   `billing.process` job. Record what the merchant's billing page shows (no units granted).
5. `docker network connect rekoda-prod_settlement-egress rekoda-prod-settlement-1`. `dc ps settlement` shows it
   healthy.
6. Recover:
   `POST https://staging-api.myrekoda.com/v1/ops/dead-jobs/<jobId>/recover`, body
   `{"reason":"staging acceptance OWN-76 recovery"}`, token with `ops:payment`.
   Expect `recovering`. The api first verifies the reference with Paystack server-side.
7. **Expected:** the units are credited exactly once, the charge is paid once, and the exception closes.
8. A second `recover` on the same job is refused. A recover with an invented job id gives `not_found`.
9. **Rollback** if step 5 is forgotten: `docker network connect rekoda-prod_settlement-egress rekoda-prod-settlement-1`, or
   `dc up -d --force-recreate settlement` (a plain `dc up -d` may leave a hand-disconnected network disconnected).

**Evidence:** the timestamps of steps 2 and 5, the job id, the exception before and after, the usage before and
after, the reference, and both recover responses.

**Still BLOCKED:** the `payment.process` (merchant customer payment) variant, because merchant Paystack TEST keys are
refused on staging (§6.3). The `resolve` path for a dead job without a reference has no safe way to be created.

### 6.2 Retention: what staging can and cannot prove

Rules (code): a trial that ended **60 days** ago and was never paid, with no checkout in flight, gets the
`rekoda_retention_notice` template. It is deleted at **90 days**, and only if notified at least **30 days** earlier.
The sweep runs every **6 hours**. The OWN-77 date tool can move a test trial's end to at most 90 days in the past.

| Can prove on staging                                                     | How                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The notice is sent once, via the approved template, to the owner's phone | Move a fresh test business's `trial_end` to −61 days; after the next sweep (≤ 6 h) the notice arrives once; a later sweep sends none                                                               |
| A business that ever paid is never noticed                               | Do the same move on a business that paid in the walkthrough; no notice                                                                                                                             |
| A business with a checkout in flight is not noticed                      | Open a checkout, do not pay, move `trial_end`; no notice                                                                                                                                           |
| No template, no deletion                                                 | Run with `META_RETENTION_TEMPLATE` unset first: the sweep warns nobody and deletes nothing                                                                                                         |
| Deletion itself, with its receipt                                        | **Only by waiting 30 real days** after the notice (the notice time cannot be moved). Optional long-running check: after 30 days the business is deleted and a `retention_deletions` receipt exists |
| **Cannot** prove                                                         | Deletion within the acceptance window; R2 object deletion of real documents beyond what that business held                                                                                         |

### 6.3 Merchant card payments

Staging runs production mode, which refuses a merchant's Paystack **TEST** key by design (`rejected_test_key`).
That guard stays.

- **On staging:** test everything around the payment, not the card charge. Record a payment by hand (cash or
  transfer) and check the booking, receipt, invoice status, ledger and the reminder suppression (ACCEPT-01
  journeys 11 and 12).
- **Supporting evidence, not acceptance:** the payments integration suites and the Playwright journeys run against
  a fake Paystack in CI.
- **The real proof** is the G-05 controlled live drill: after Paystack's written §47 confirmation, with your own live
  merchant key, a small amount, and explicit `LIVE_MODE_ALLOWED = YES`.
- **Report it as `LIVE-PROVIDER REQUIRED`, never PASS.**

### 6.4 Usage exhaustion (missing test, now defined)

Use fresh trial businesses. Read the actual allowance on the billing page first; the database's catalogue is the
authority, and trial defaults are 10 report downloads and 50 AI actions.

| #   | Steps                                                                                                                          | Expected                                                                                                                                                                                                                     | Evidence            |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| E1  | Download a report (any CSV/PDF from Reports) until the trial allowance is used                                                 | Each download counts once ("This month" increases by exactly 1)                                                                                                                                                              | Usage after each    |
| E2  | One more download                                                                                                              | Refused: "You have used the downloads included in your free trial. Your books are still here to read, and Settings has a full data export that never counts against this." No file; counter unchanged; no mention of a month | Screenshot; counter |
| E3  | Settings → full data export                                                                                                    | Works and does not count                                                                                                                                                                                                     | Screenshot          |
| E4  | On WhatsApp, send recordable messages until AI actions are used up (≈50 short messages)                                        | Each confirmed action counts once                                                                                                                                                                                            | Counter             |
| E5  | One more recordable message                                                                                                    | "You have used all N messages included in your free trial. Nothing is lost…" and "Reply _upgrade_ to choose a plan and keep going."; no draft created; no mention of a month                                                 | Screenshot          |
| E6  | `who owes me`, `payment details`, `help`                                                                                       | Still answered (free commands)                                                                                                                                                                                               | Screenshots         |
| E7  | Upgrade to Chat with a TEST card                                                                                               | Allowance rises; the next message works                                                                                                                                                                                      | Screenshots         |
| E8  | Lapsed business (`paid_to` −8 days with the staging tool, then the next renewal/grace sweep marks it expired) tries a download | "Downloads are paused while your subscription is stopped…" (not the used-up wording)                                                                                                                                         | Screenshot          |

The trial wording was corrected in PR #432 (it used to say "this month" on a trial, whose allowance is one budget for
its 14 days, G-109). A paid plan keeps "this month". Regression tests: `packages/core/src/replies.test.ts`,
`apps/api/src/jobs/jobs-chat-roles-1.integration.test.ts`, `apps/api/src/reports/exports.integration.test.ts`.

### 6.5 Tests that must stay BLOCKED or LIVE-PROVIDER REQUIRED

| Test                                                                                               | Status                                                                                            | Why                                            |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Dead-job recovery (§6.1)                                                                           | BLOCKED / PENDING Angelo's explicit written approval; not run                                     | OWN-77 scope                                   |
| `payment.process` dead-job recovery; merchant card payment end to end                              | LIVE-PROVIDER REQUIRED                                                                            | merchant TEST keys refused by design           |
| ACCEPT-01 17(b) worker-job retry exactly once                                                      | BLOCKED                                                                                           | no procedure; §6.1 covers only settlement jobs |
| Retention deletion                                                                                 | PENDING 30 real days                                                                              | the notice time cannot be moved                |
| Template steps (trial, grace, document, retention)                                                 | BLOCKED per template until Meta shows Approved                                                    | external                                       |
| Live Paystack, live refunds (G-05, G-06), production Meta number (G-03), live AI evaluation (G-07) | LIVE-PROVIDER REQUIRED                                                                            | not authorised                                 |
| Same-charge duplicate payment refund                                                               | Only partly testable: the refund is by hand in the TEST dashboard; OD-53 (1), (2), (5) still open | owner decisions                                |

## 7. Pre-merge checklist (Angelo, on Hetzner, Cloudflare and R2; nothing deploys yet)

| #   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pass when                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| P1  | Hetzner snapshot `pre-pr432-<date>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | snapshot listed                                                                 |
| P2  | Rescale to 8 GB (§3); add 2 GiB swap; staging comes back healthy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `free -h` about 7.7 GiB plus swap; `https://staging-api.myrekoda.com/health` ok |
| P3  | Disk: `df -h /opt/rekoda /var/lib/docker` shows at least 8 GiB free on each; if not, "Docker cleanup by hand (staging)" in `deploy.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ≥ 8 GiB free                                                                    |
| P4  | R2 bucket, token, lock and lifecycle (§1.2); `/etc/rekoda/backup.env` and `backup.pass` (§1.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | files 0600 root; passphrase copy in the password manager                        |
| P5  | Paystack key, never printed, by the deploy's own rule (bash, in `/opt/rekoda`): (1) `for n in PAYSTACK_SECRET_KEY REKODA_PAYSTACK_PLATFORM_CONFIRMED; do [ "$(LC_ALL=C grep -v '^[[:space:]]*#' .env \| LC_ALL=C grep -cE "$n([^A-Za-z0-9_]\|\$)")" = "$(LC_ALL=C grep -c "^$n=" .env)" ] && echo "$n PLAIN"; done`; (2) `v=$(sed -n 's/^PAYSTACK_SECRET_KEY=//p' .env \| tail -1); case "$v" in \"*\") v=${v#\"}; v=${v%\"} ;; \'*\') v=${v#\'}; v=${v%\'} ;; esac; [[ "$v" =~ ^sk_test_[A-Za-z0-9]+$ ]] && echo TEST; unset v`; (3) `sed -n 's/^REKODA_PAYSTACK_PLATFORM_CONFIRMED=//p' .env \| tail -1`. The deploy refuses anything else and is the authority; check before merging rather than learn it from a refused deploy. | (1) both `PLAIN`; (2) `TEST`; (3) nothing, or `0`                               |
| P6  | Pending Rekoda charges (read-only): `dc exec -T postgres psql -U rekoda_owner -d rekoda -c "SELECT reference, kind, created_at FROM subscription_charges WHERE status='pending'"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | list saved                                                                      |
| P7  | **Backup and restore drill on R2** (§1.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `backup: ok …` and `restore-drill: PASS` recorded                               |
| P8  | Enter §4.1 values; verify §4.2 to §4.5 by name: `grep -cE '^(SETTLEMENT_DATABASE_URL=postgres://rekoda_settlement:\|OPERATOR_DATABASE_URL=postgres://rekoda_billing_operator:\|OPERATOR_BILLING_OIDC_AUDIENCE=.\|VAULT_KEY=.\|OPERATOR_OIDC_ISSUER=.\|OPERATOR_OIDC_JWKS_URL=.\|OPERATOR_OIDC_AUDIENCE=.)' .env` → `7`; audiences differ: `[ "$(sed -n 's/^OPERATOR_BILLING_OIDC_AUDIENCE=//p' .env)" != "$(sed -n 's/^OPERATOR_OIDC_AUDIENCE=//p' .env)" ] && echo DIFFERENT`                                                                                                                                                                                                                                                      | `7`, `DIFFERENT`                                                                |
| P9  | Meta: the four required templates show Approved; webhook and test recipients set (§4.3). Resend domain Verified and webhook set (§4.4). Paystack TEST webhook set (§4.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | as stated                                                                       |
| P10 | Identity provider: a token for the billing audience with `ops:billing`, and API-audience tokens with `ops:read`, `ops:payment`, `ops:staging`, can be minted (never pasted anywhere)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | yes                                                                             |
| P11 | Optional approval gate (§5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | your choice                                                                     |
| P12 | Your explicit approval to merge #432                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | given                                                                           |

Do not change the Cloudflare proxy mode or the firewall in the same window (§2.1).

## 8. Post-merge staging verification sequence

| #   | Who       | Action                                                                                                                                                                                                                                                                     | Pass when                                                                                                                                                            |
| --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Angelo    | Squash-merge #432 (explicit message, no trailers)                                                                                                                                                                                                                          | merged                                                                                                                                                               |
| D2  | automatic | CI on `main` (about 10 minutes), then Deploy staging starts by itself (or waits for approval if you set the optional gate)                                                                                                                                                 | CI green on the merge SHA                                                                                                                                            |
| D3  | automatic | `deploy-staging.sh`: refuses on a non-TEST Paystack key or a missing credential; builds api, then web; stops api, worker, operator and settlement; migrates 0193 to 0223 and sets four role passwords; pre-start smoke `t`; starts everything; `/health` names the release | run green; its log shows `runtime role passwords set: rekoda_app, rekoda_worker, rekoda_settlement, rekoda_billing_operator`, and `/health` shows `"migrations":224` |
| D4  | Angelo    | `dc ps` lists api, worker, web, settlement, operator and postgres healthy; `dc logs settlement \| grep 'job runner started'` ends `Paystack key set`; `dc logs operator \| grep listening` shows `identity: verified tokens`                                               | all                                                                                                                                                                  |
| D5  | Angelo    | `curl -s -o /dev/null -w '%{http_code}' -X POST https://staging-api.myrekoda.com/v1/businesses/plan`                                                                                                                                                                       | `401`                                                                                                                                                                |
| D6  | Angelo    | Release preflight: `dc run --rm -T migrate sh /repo/deploy/migrate.sh preflight-subscriptions`                                                                                                                                                                             | exit 0 (on 1: correct each listed test business per `deploy.md`; on 2: stop and report)                                                                              |
| D7  | Angelo    | Read-only check: `ssh <user>@<host> 'EXPECT_SHA=<merge sha> EXPECT_WEB_URL=https://staging.myrekoda.com bash -s' < scripts/staging-readonly-check.sh`                                                                                                                      | `RESULT: OK`, including `PAYSTACK_SECRET_KEY (settlement)  SET (TEST-KEY)`                                                                                           |
| D8  | Angelo    | Post-deploy backup and drill: `sudo systemctl start rekoda-backup.service`, then the drill (§1.5)                                                                                                                                                                          | both pass on the 0223 schema                                                                                                                                         |
| D9  | Angelo    | Enable the timer (§1.6)                                                                                                                                                                                                                                                    | next run listed                                                                                                                                                      |
| D10 | Angelo    | Website: `https://staging.myrekoda.com/` loads; `/start` sign-in by WhatsApp OTP; `/app/billing` shows the trial                                                                                                                                                           | as stated                                                                                                                                                            |
| D11 | Angelo    | WhatsApp: send "help" and a sale to the test number; replies arrive                                                                                                                                                                                                        | as stated                                                                                                                                                            |
| D12 | Angelo    | Staging tools: `REKODA_STAGING_TOOLS=1` in `.env`; `dc up -d --wait --force-recreate api worker`; as owner `INSERT INTO staging_environment (marked_by, note) VALUES ('owner:<name>', 'staging acceptance, OWN-77');`                                                      | healthy                                                                                                                                                              |
| D13 | Angelo    | Re-run D7                                                                                                                                                                                                                                                                  | `RESULT: OK`                                                                                                                                                         |

If D3 refuses, nothing has been changed: fix `.env` and start Deploy staging again from the Actions tab.
Run every `docker compose` command by hand **from a clean login shell** (never one where a key was exported): compose
reads `${NAME}` from the shell before `.env`. The deploy script clears those names itself; a hand-typed command does
not.

**Rollback:** never a down migration. Restore the P7 backup into a stopped stack (`backup-restore.md`, "Restore by
hand"), with `operator` and `settlement` stopped first. The Hetzner snapshot is the last resort. Prefer fixing
forward.

## 9. Acceptance tests (Angelo)

Run in this order. Rows marked † need staging tools (D12).

**Ready to run:**

- SUB-ACC walkthrough steps 1 to 23 (17 to 19 and 22 †), on desktop and phone width.
- ACCEPT-01 journeys 1 to 16 (2, 3, 9, 10 †; 11 to 16 after `REKODA_CUSTOMER_REMINDERS=1`).
- Usage exhaustion E1 to E8 (§6.4).
- Operator billing: a plan change with a billing-audience token; a support review; an API-audience token is refused.
- Retention notice (§6.2) †.
- Duplicate pack purchase (two pack links paid; `docs/runbooks/billing-duplicate-payments.md`).
- Backup and restore (§1.5).

**Blocked or limited:** §6.5. The dead-job failure injection (§6.1) is BLOCKED / PENDING Angelo's written approval.

Evidence for every row: date, tester, commit, expected, actual, safe reference, desktop/mobile,
PASS / FAIL / BLOCKED / LIVE-PROVIDER REQUIRED. A green CI run is never a PASS.

## 10. What changed since revision 2

| Change                                                                                                                                                                                                                                                                              | Where                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The staging deploy refuses a `.env` whose `PAYSTACK_SECRET_KEY` is not an `sk_test_` key (missing, empty, live, malformed; quotes allowed), and `REKODA_PAYSTACK_PLATFORM_CONFIRMED=1`, on **every** staging deploy, before building or stopping anything; the key is never printed | `scripts/deploy-staging.sh`; tests `scripts/deploy-staging-compat.test.mjs`                                                  |
| The read-only check asks the **settlement** container for its own Paystack key (UNSET, live, unrecognised or unreadable needs attention)                                                                                                                                            | `scripts/staging-readonly-check.sh`; tests `scripts/staging-readonly-check.services.test.mjs`                                |
| A trial's exhaustion messages name the free trial, not "this month" (chat and report downloads)                                                                                                                                                                                     | `packages/core/src/replies.ts`, `apps/api/src/jobs/inbound-message.handler.ts`, `apps/api/src/reports/reports.controller.ts` |
| Staging application settings are entered by hand on the host; GitHub holds only the deploy credentials                                                                                                                                                                              | §0, §5; `deploy.md`; `REKODA_LAUNCH_READINESS.md`                                                                            |
| The deploy clears every name the compose file interpolates from its own shell (except `REKODA_RELEASE`), so `.env` is the only source; it refuses `export`, indented or spaced spellings of the two Paystack names                                                                  | `scripts/deploy-staging.sh`; tests `scripts/deploy-staging-compat.test.mjs`                                                  |
| Converting a quote with the trial's documents used up names the free trial (the API returns the allowance window)                                                                                                                                                                   | `apps/api/src/reports/reports.controller.ts`, `packages/contracts/src/reports-api.ts`, `apps/web/src/lib/allowance-copy.ts`  |
| Docker cleanup procedure for the staging host                                                                                                                                                                                                                                       | `deploy.md`, "Docker cleanup by hand (staging)"                                                                              |
| R2 specifics in the backup runbook                                                                                                                                                                                                                                                  | `backup-restore.md`                                                                                                          |

Still open, none blocking the deploy: Angelo's written ruling on the §6.1 procedure; OD-53 before paid launch; the dashboard and billing usage meters are still headed "this month" for a trial (`apps/web/src/app/app/page.tsx`, `billing/page.tsx`), a UI follow-up that needs its own design pass. E1's "This month" counter refers to that heading.
