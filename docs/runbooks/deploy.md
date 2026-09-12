# Runbook: deploy, operate and roll back

Target: one Linux host running Docker Compose, with Cloudflare in front and
Caddy terminating TLS on the host (ADR 0006). Every file this runbook names
ships in the repository: `Dockerfile`, `docker-compose.prod.yml`,
`deploy/Caddyfile` and `deploy/migrate.sh`. CI boots this exact stack from a
clean checkout on every change and walks the steps below
(`scripts/deploy-smoke.sh`, the "Deployment (Docker)" job), so a runbook step
that stops working fails a pull request before it fails a deploy.

Every command runs from the checkout (`/opt/rekoda`) as the deploy user. The
examples use one alias:

```bash
alias dc='docker compose -f docker-compose.prod.yml'
```

## What runs, and who holds which credential

| Service    | Image                  | What it is                                                                                          |
| ---------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `caddy`    | `caddy:2.11.4-alpine`  | The only published ports (80, 443, 443/udp). TLS, the two hostnames, the client address             |
| `web`      | `rekoda-web:<release>` | `next start`, with the site's public values baked in at build                                       |
| `api`      | `rekoda-app:<release>` | The API, `REKODA_WORKER=0`                                                                          |
| `worker`   | `rekoda-app:<release>` | The same image, `REKODA_WORKER=1`: the job runner and the sweeps                                    |
| `postgres` | `postgres:16-alpine`   | The database, on the `pgdata` volume, on a network with no route in or out and no published port    |
| `migrate`  | `rekoda-app:<release>` | A one-off, never started by `up`: `dc run --rm -T migrate` (migrations, then the runtime passwords) |

| Credential                                     | Lives in                          | Reaches                                                                                                         |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| PostgreSQL owner (superuser, migrations)       | `secrets/postgres_owner_password` | `postgres` and the `migrate` job. Never `api`, `worker` or `web`                                                |
| `rekoda_app` (RLS-bound)                       | `DATABASE_URL` in `.env`          | `api`, `worker`; `migrate` reads it only to set the role's password                                             |
| `rekoda_worker` (claims jobs across tenants)   | `WORKER_DATABASE_URL` in `.env`   | `worker`, and `api` (it routes a message on a merchant's own WhatsApp number to its tenant); `migrate` as above |
| Application secrets (`VAULT_KEY` and the rest) | `.env`                            | `api`, `worker`                                                                                                 |
| Anything at all                                | nowhere else                      | `web` receives only `NODE_ENV`, `REKODA_API_URL` and `REKODA_WEB_URL`                                           |

The compose file sets some values itself, whatever `.env` says:
`NODE_ENV=production` everywhere, `PORT`, `REKODA_WORKER`, the API's
`REKODA_TRUSTED_PROXIES` (Caddy's fixed address, `172.30.10.10`) and web's
`REKODA_API_URL` (`http://api:3001`, the internal network). Two CI guards keep
this shape: `scripts/check-deploy.mjs` (ports, the owner secret, networks,
users, no secret in an image) and `scripts/check-env-example.mjs` (every name
the deployment reads is documented, and web gets exactly what it reads).

## Values the owner supplies

Nothing below is ever committed. Keep the canonical copy in the host's
secret store (a password manager or a secrets vault); `.env` (mode 600) and
`secrets/` (mode 700) on the host are the working copies. The full inventory,
with sandbox notes per provider, is `docs/REKODA_LAUNCH_READINESS.md` §11.1.

- **Generate per environment, never reuse between staging and production**
  (`openssl rand -hex 32` each): the owner password
  (`secrets/postgres_owner_password`), the `rekoda_app` and `rekoda_worker`
  passwords (inside the two URLs), `VAULT_KEY`, `MATCH_KEY`,
  `CONNECTION_KEY`, `REKODA_API_SECRET`, `OTP_PEPPER`, `META_VERIFY_TOKEN`.
- **From providers:** `META_APP_SECRET`, `META_ACCESS_TOKEN` and the template
  names, `PAYSTACK_SECRET_KEY` (a test key for staging),
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, the four `R2_*` values, `MONO_*`,
  and the three `OPERATOR_OIDC_*` values from the identity provider.
- **Facts the owner decides:** the hostnames (`NEXT_PUBLIC_SITE_URL`,
  `REKODA_API_PUBLIC_URL`, `REKODA_WEB_URL`, `REKODA_CORS_ORIGINS`), the ACME
  contact (`REKODA_ACME_EMAIL`), the legal facts (`NEXT_PUBLIC_LEGAL_*`,
  `NEXT_PUBLIC_PRIVACY_EMAIL`, `NEXT_PUBLIC_SUPPORT_EMAIL`), Rekoda's WhatsApp
  number, and the command-bus flags (OD-4).

A value in `.env` must not contain a `$`: compose reads the file too and would
treat it as a variable. Every generated value above is hex.

## First deployment on a clean host

1. **Host.** Ubuntu LTS, a non-root deploy user, SSH keys only
   (`PasswordAuthentication no`), `ufw` allowing 22, 80, 443 and 443/udp
   only. Install Docker Engine and the compose plugin.
2. **DNS.** Point the site and API hostnames at the host with **A records
   only** (no AAAA): the compose networks are IPv4, and Docker would present
   every IPv6 visitor to Caddy as one internal address. Leave the
   Cloudflare records **DNS only** (grey) until Caddy has certificates, then
   proxy them with SSL/TLS mode **Full (strict)**, keep Cloudflare's "Always
   Use HTTPS" **off** (Caddy redirects already, and certificate renewals
   arrive over plain HTTP), and set `REKODA_EDGE_PROXIES` to Cloudflare's
   published ranges (https://www.cloudflare.com/ips/, space-separated).
   Without that, every visitor shares Cloudflare's addresses in the per-IP
   limits.
3. **Checkout.** `git clone` to `/opt/rekoda` and `git checkout vX.Y.Z`
   (a tag, never a branch tip).
4. **The owner secret.** The directory is the deploy user's alone; the file
   inside must be readable by the `postgres` and `node` users of the two
   containers it is mounted into, which compose cannot re-own:

   ```bash
   install -d -m 700 secrets
   openssl rand -hex 32 > secrets/postgres_owner_password
   chmod 644 secrets/postgres_owner_password
   ```

5. **`.env`.** `cp .env.example .env && chmod 600 .env`, then fill it from
   the secret store. Set `REKODA_RELEASE=vX.Y.Z`. The two database URLs are
   `postgres://rekoda_app:<password>@postgres:5432/rekoda` and
   `postgres://rekoda_worker:<password>@postgres:5432/rekoda`. Leave
   `REKODA_OPERATOR_SECRET`, `REKODA_LOCAL_STORAGE`, `PAYSTACK_BASE_URL`,
   `MONO_BASE_URL` and every test hook unset.
6. **Build.** Before anything starts:

   ```bash
   dc build --build-arg REKODA_COMMIT=$(git rev-parse --short HEAD)
   ```

   The web build refuses to run without `NEXT_PUBLIC_SITE_URL` and the five
   mandatory legal facts, because Next bakes them into the pages.

7. **Database.** Start PostgreSQL, then migrate:

   ```bash
   dc up -d --wait postgres
   dc run --rm -T migrate
   ```

   Expect `applied: 0000_init, …` and then
   `runtime role passwords set: rekoda_app, rekoda_worker`.

8. **Start everything.** `dc up -d --wait`. Caddy obtains the certificates on
   first start.
9. **Health.** `curl -fsS https://<api host>/health` must show
   `"status":"ok"`, `"database":"up"`, `"migrations":152` (the count of
   entries in `packages/db/migrations/meta/_journal.json`), and the
   `release` and `commit` just built.
10. **Worker.** See "Is the worker working?" below.

The first API boot enrols the `VAULT_KEY` and `MATCH_KEY` fingerprints in the
database (key-rotation.md, "Fingerprint enrolment"): from then on a boot with
different keys refuses to start. Keep the secret-store copy exact.

## Deploy a release

```bash
cd /opt/rekoda
git fetch --tags && git checkout vX.Y.Z
sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=vX.Y.Z/' .env
dc build --build-arg REKODA_COMMIT=$(git rev-parse --short HEAD)   # build BEFORE touching anything live
dc run --rm -T migrate                                             # expand-only migrations, as the owner
dc up -d --wait                                                    # recreates api, worker and web on the new images
dc exec caddy caddy reload --config /etc/caddy/Caddyfile            # apply a changed Caddyfile (validated first)
curl -fsS https://<api host>/health                                # release must now read vX.Y.Z
```

`/health` answers `ok` only when the database holds every migration the new
image carries, so an image started before its migrate job is `degraded`, its
container is unhealthy, and `up --wait` fails instead of reporting success.

`up` recreates a container only when its compose configuration or image
changed; Caddy's is neither when only the Caddyfile changes, hence the
reload. Caddy validates the new file first and keeps serving the old one if
it does not parse.

The previous release's images stay on the host (`rekoda-app:<previous>`,
`rekoda-web:<previous>`); that is what makes rollback a one-line change. Keep
at least the last two releases before any `docker image prune`.

Migration discipline: **expand, deploy, contract.** A migration in the same
release as the code that needs it must be backward-compatible with the
previous release (additive columns and tables). Destructive contractions ship
one release later.

## Rotate a database password

The migrate job sets `rekoda_app` and `rekoda_worker` to the passwords in
`.env` on every run, so on an ordinary deploy it re-sets the same ones. A
rotation changes them, and the running api and worker still hold the old
URLs: connections they already have stay open, but any new one is refused.
So a rotation is one short, deliberate sequence, not part of a deploy:

```bash
# 1. put the new password(s) in DATABASE_URL and/or WORKER_DATABASE_URL in .env
dc run --rm -T migrate                            # 2. the database now accepts only the new ones
dc up -d --wait --force-recreate api worker       # 3. at once: new containers, new URLs
curl -fsS https://<api host>/health               # 4. ok
```

If step 3 fails, put the old URLs back in `.env` and run step 2 again, so the
database accepts what the running containers hold, then find out why. The
owner password is rotated separately, inside PostgreSQL, and then in
`secrets/postgres_owner_password`.

## Health and readiness

- `GET /health` (public, not rate-limited) answers `status` (`ok` only when
  the database is up and holds at least every migration this image carries),
  `database`, the migration
  count, and the running `release` and `commit`. Nothing about the host, the
  database or a credential.
- `dc ps` shows each container's health: `api` and `worker` pass when their
  own `/health` says `ok`, `web` when `/terms` answers, `postgres` on
  `pg_isready`. `web` waits for a healthy `api`, and `caddy` for both.
- `GET /v1/ops/health` with an operator token (`ops:read`) adds queue depth,
  dead jobs and webhook failure counts.

## Is the worker working?

```bash
dc logs worker | grep 'job runner started'        # the worker's runner is on
dc logs api | grep 'job runner disabled'          # and the api's is off
dc exec -T postgres psql -U rekoda_owner -d rekoda -c \
  "SELECT state, count(*), min(run_at) FILTER (WHERE state = 'pending') AS oldest_due FROM jobs GROUP BY state"
```

`pending` should not grow and its oldest due time should stay recent; `dead`
rows carry their reason in `last_error`. `/v1/ops/health` shows the same with
an operator token.

## Logs

```bash
dc logs -f --tail 200 api worker web caddy
```

Each container's log is rotated at 10 MB, five files kept. The application
redacts before it logs. Caddy keeps **no access log** by design: query
strings carry one-tap sign-in links and Meta's verify token, and a log line
holding either is a credential at rest. Do not switch one on.

## Safe restart

- **One service:** `dc restart api` (or `worker`, `web`, `caddy`). Meta and
  Paystack retry a webhook that meets a restart; a job claimed by a worker
  that stops is requeued once it is stale (five minutes).
- **After editing `.env`:** `dc up -d --wait` recreates the api, worker and
  Caddy when their values changed. **Not the site's public values:** every
  `NEXT_PUBLIC_*` value (the site URL, the legal facts, the WhatsApp number,
  the Mono public key) is baked into the web image at build, and compose does
  not rebuild or recreate it for a changed build argument. Change one, then
  set a new `REKODA_RELEASE` and run the whole "Deploy a release" sequence, so
  the pages, the legal gate and `/health` all name the new build.
- **After editing the Caddyfile:**
  `dc exec caddy caddy reload --config /etc/caddy/Caddyfile` (validates, then
  swaps without dropping connections; the compose file mounts the whole
  `deploy/` directory so the container sees a file a checkout replaced).
- **The whole stack:** `dc down` then `dc up -d --wait`. The `pgdata`,
  `caddy_data` and `caddy_config` volumes survive.
- **Never `dc down -v`** on a real host: it deletes the database and the
  certificates.

## Roll back

```bash
git checkout vPREVIOUS
sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=vPREVIOUS/' .env
dc up -d --wait                      # the previous images are still on the host: no build
dc exec caddy caddy reload --config /etc/caddy/Caddyfile
curl -fsS https://<api host>/health  # release must read vPREVIOUS
```

Check out the previous tag as well as changing the line, so the compose file
and the Caddyfile match the images. If those images were pruned, run the
build step first. Because migrations are expand-only, the previous release
runs against the newer schema. A migration that must itself be reverted is a
restore from backup, and **there is no backup mechanism yet** (G-02 in
`docs/REKODA_LAUNCH_READINESS.md`; `backup-restore.md` describes the plan).

## What must never be run

- **Never give the app credentials to anything but the app.** Migrations
  refuse a role without SUPERUSER or BYPASSRLS, so `migrate:apply` with
  `rekoda_app` fails; and with any other RLS-bound role a data migration would
  report success while updating no rows. A `pg_dump` taken as `rekoda_app`
  or `rekoda_worker` sees no tenant's rows and produces an empty backup that
  looks complete. Backups run as the owner.
- **Never give the owner credential to the app.** Do not put the owner in
  `DATABASE_URL` or `WORKER_DATABASE_URL`, and never
  `dc run -e DATABASE_URL=<owner> api`: the boot doctor refuses a role that
  can bypass RLS, the migrate job refuses a runtime URL that names another
  role, and CI proves both on every change. The only place the owner
  credential goes is the `migrate` job.
- **Never grant BYPASSRLS** to `rekoda_app` or `rekoda_worker`.
- **Never publish PostgreSQL's port**, not even "to debug": use
  `dc exec postgres psql -U rekoda_owner -d rekoda`.
- **Never set a test hook or a development switch** on a real deployment:
  `REKODA_E2E_PLACEHOLDER_LEGAL` (switches off the legal-facts gate),
  `REKODA_E2E_REVEAL_OTP`, `REKODA_REVEAL_OTP`, `REKODA_OPERATOR_SECRET`,
  `REKODA_LOCAL_STORAGE`, `PAYSTACK_BASE_URL`, `MONO_BASE_URL`. The compose
  file names none of them and CI keeps it that way, but `.env` reaches the
  api and the worker whole.
- **Never `dc down -v`** outside a throwaway machine.
- **Never read an empty `psql` result as the app role as data loss:** RLS
  shows `rekoda_app` nothing until a tenant is pinned.

## Staging and production

The same files and the same commands. Only `.env` differs: the hostnames,
test-mode provider keys (`sk_test_`, a test WhatsApp number), a staging
identity-provider tenant, separately generated keys and passwords, and the
legal facts (staging placeholders only while the staging hostname is not
shared or linked anywhere, since the host answers publicly for its
certificates; the web build still refuses them blank). `NODE_ENV` is
`production` in both; the API treats anything but development and test as
production anyway.

## What a production boot refuses

Each process validates its environment before serving anything, and each
failure below is a one-line startup error naming the variable:

- **API and worker:** every required variable is shape-checked
  (`loadConfig`); the database roles must not be SUPERUSER or BYPASSRLS;
  `VAULT_KEY` and `MATCH_KEY` must match their enrolled fingerprints;
  `REKODA_TRUSTED_PROXIES` must be set (the compose file sets it);
  `REKODA_RELEASE` and `REKODA_COMMIT` must be short tokens.
- **Web** (`next start`): every mandatory legal fact must be set, or the
  server refuses to serve policy pages with placeholder badges (R8). In this
  deployment the facts are baked into the image at build and checked again
  at start, so the gate checks the same values the pages show.
- **Migrate:** the owner password must be letters and digits, at least 24;
  the two runtime URLs must name `rekoda_app` and `rekoda_worker`, point at the
  same database, and carry a password of at least 24 printable ASCII
  characters.

A refused boot is the control working. Fix the environment; do not patch the
check out.

## Smoke checklist after every deploy

- [ ] `/health` returns `ok`, 152 migrations (or the new count), and the new release
- [ ] `dc ps`: every service healthy
- [ ] Worker: `job runner started` in its log, and no growing `pending` backlog
- [ ] Send a WhatsApp message to the Rekoda number; the reply arrives
- [ ] Dashboard sign-in completes
- [ ] `SELECT max(created_at) FROM external_events` is recent (webhooks flowing)
- [ ] Trial-balance job: zero drift rows
