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

| Service      | Image                  | What it is                                                                                                                                   |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy`      | `caddy:2.11.4-alpine`  | The only published ports (80, 443, 443/udp). TLS, the two hostnames, the client address                                                      |
| `web`        | `rekoda-web:<release>` | `next start`, with the site's public values baked in at build                                                                                |
| `api`        | `rekoda-app:<release>` | The API, `REKODA_WORKER=0`                                                                                                                   |
| `worker`     | `rekoda-app:<release>` | The same image, `REKODA_WORKER=1`: the job runner and the sweeps                                                                             |
| `postgres`   | `postgres:16-alpine`   | The database, on the `pgdata` volume, on a network with no route in or out and no published port                                             |
| `migrate`    | `rekoda-app:<release>` | A one-off, never started by `up`: `dc run --rm -T migrate` (migrations, then the runtime passwords)                                          |
| `edge-check` | `rekoda-app:<release>` | A one-shot `up` runs before Caddy (`node dist/edge-check.js`): exits 0 when `REKODA_EDGE_PROXIES` is safe, 1 when it refuses it (G-74, G-75) |

| Credential                                     | Lives in                          | Reaches                                                                                                         |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| PostgreSQL owner (superuser, migrations)       | `secrets/postgres_owner_password` | `postgres` and the `migrate` job. Never `api`, `worker` or `web`                                                |
| `rekoda_app` (RLS-bound)                       | `DATABASE_URL` in `.env`          | `api`, `worker`; `migrate`, which loads all of `.env` to set the role's password from it                        |
| `rekoda_worker` (claims jobs across tenants)   | `WORKER_DATABASE_URL` in `.env`   | `worker`, and `api` (it routes a message on a merchant's own WhatsApp number to its tenant); `migrate` as above |
| Application secrets (`VAULT_KEY` and the rest) | `.env`                            | `api`, `worker`, and the `migrate` job (the same image, run on demand)                                          |
| Anything at all                                | nowhere else                      | `web` receives only `NODE_ENV`, `REKODA_API_URL` and `REKODA_WEB_URL`                                           |

The compose file sets some values itself, whatever `.env` says:
`NODE_ENV=production` everywhere, `PORT`, `REKODA_WORKER`, the API's
`REKODA_TRUSTED_PROXIES` (Caddy's fixed address, `172.30.10.10`), the API's
`REKODA_TRUSTED_WEB` (web's fixed address, `172.30.10.11`) and web's
`REKODA_API_URL` (`http://api:3001`, the internal network). Caddy is the one
place a visitor's address is decided: it writes it to the API as
`X-Forwarded-For` and to web as `X-Rekoda-Client-IP`, which web hands on to
the API for every call it makes for that visitor, and which the API believes
from web's address alone, so each visitor has their own rate-limit bucket
(G-71). Two CI guards keep
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
   only. Install Docker Engine and a current Compose v2 plugin: the edge
   check is a one-shot service Caddy waits for, so `up --wait` must treat a
   dependency that exited 0 as satisfied rather than waiting for it to keep
   running. The smoke prints the engine and Compose versions it proved the
   stack on at the top of the CI Deployment job; match or exceed them. An
   older Compose tends to hang on that wait rather than report, so give the
   command a deadline the first time: `dc up -d --wait --wait-timeout 300`.
2. **DNS.** Point the site and API hostnames at the host with **A records
   only** (no AAAA): the compose networks are IPv4, and Docker would present
   every IPv6 visitor to Caddy as one internal address. Leave the
   Cloudflare records **DNS only** (grey) until Caddy has certificates, then
   proxy them with SSL/TLS mode **Full (strict)**, keep Cloudflare's "Always
   Use HTTPS" **off** (Caddy redirects already, and certificate renewals
   arrive over plain HTTP), and set `REKODA_EDGE_PROXIES` to Cloudflare's
   published ranges (https://www.cloudflare.com/ips/, space-separated). A
   universal value there is refused before Caddy starts (G-74), because it
   would let any browser choose the address the per-IP limits count, and so
   is `private_ranges` or any range holding the edge network's gateway
   (G-75), which would let every IPv6 visitor do the same.
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
   first start. Then confirm the edge network is the one the edge check
   knows (G-75):
   `docker network inspect rekoda-prod_edge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}} {{.EnableIPv6}}'`
   must print `172.30.10.1 false`. Anything else means Docker kept an older
   network: `dc down` (never `-v`) and `dc up -d --wait` recreate it.
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
at least the last two releases before any `docker image prune`. Roll the
checkout back with the release, always together: the compose file names the
edge check's entry inside the image (`dist/edge-check.js` since G-75,
`dist/edge-proxies.js` before it). Rolling only `REKODA_RELEASE` back points
the job at an image without the entry it names, and the `up` fails loudly;
rolling only the checkout back is worse, because the older command then runs
a file of the newer image that no longer checks anything, and exits 0.
Caddy keeps serving throughout, because it proxies by service
name and is never recreated; the api, worker and web may already have been
recreated on the older images by then, so finish the rollback rather than
leaving it half applied.

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

If step 3 fails, put the old URLs back in `.env`, run step 2 again, and run
step 3 again: a container step 3 already recreated holds the new URL, and
only a second `--force-recreate` gives both the restored one. Then find out
why. The
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
  Paystack retry a webhook that meets a restart. A stopping worker finishes
  the jobs it holds first (it is given 150 seconds, the api 30), so a restart
  or a deploy can take that long; a worker killed anyway leaves its job to be
  requeued once it is stale (five minutes).
- **Not after an `up` the edge check refused** (G-74). That `up` leaves a
  Caddy container in `created`, holding the value that was rejected, and
  `dc restart caddy` (or `dc start caddy`) would start it and serve exactly
  the trust list the check refused. Fix `REKODA_EDGE_PROXIES` in `.env` and
  run `dc up -d --wait` again, which re-runs the check; `dc rm -f caddy`
  first if you want the loaded container gone before you do. The same goes
  for any service left in `created` by a refused `up`: `dc ps -a` shows the
  state, and `up` is what applies a corrected `.env`.
- **After editing `.env`:** `dc up -d --wait` recreates the api, worker and
  Caddy when their values changed, and re-runs the edge check, which refuses
  a `REKODA_EDGE_PROXIES` that would trust effectively the whole internet
  (G-74) or the edge network's gateway (G-75). `dc ps -a` shows `edge-check` as `Exited (0)` when the check
  passed and `Exited (1)` when it refused; neither is a crashed service.
  **Changing `REKODA_EDGE_PROXIES` on a live host:** run the check first,
  `dc run --rm -T edge-check`, which reads the edited `.env` and prints
  the refusal if there is one. Only then `dc up -d --wait`: compose
  recreates Caddy before the check runs, so a value the check refuses takes
  the site down until a corrected `up`. **Not the site's public values:** every
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
- **Never `dc up -d --no-deps caddy`, never `--scale edge-check=0`, and
  never a second compose file** (`-f override.yml`): each skips the edge
  check, or can (an override may `!reset` Caddy's wait on it, and CI checks
  only `docker-compose.prod.yml`), and starts Caddy with whatever `.env` now
  says (G-74). Bring Caddy up the ordinary way, which runs the check first.
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

## Roll back one write command (OD-4)

Every write runs through the command bus by default (OWN-22). Do not set any
`REKODA_COMMAND_*` variable in a normal deployment. If one write command
misbehaves on the bus and must run directly while it is fixed:

```bash
echo 'REKODA_COMMAND_RECORD_PURCHASE=0' >> .env   # only the affected command
dc up -d --wait                                   # recreates api and worker on the SAME image: no build
curl -fsS https://<api host>/health
```

Then run one smoke transaction for that command (for a purchase: a chat
purchase and its yes) and check it booked once. Record the rollback, its
reason and its time where operations notes live: it is temporary.

**Restore:** delete the line (or set it to `1`), `dc up -d --wait`, check
`/health`, and repeat the smoke transaction: the command is back on the bus
(an `idempotency_records` row appears for it again).

Only `1` and `0` are accepted; any other value (`false`, `off`, a typo)
refuses to start the api and worker, naming the variable, so a mistyped
rollback is never silently ignored. **Never use this for a HIGH_RISK
command** (refunds, voids, reopening a period, erasure and the rest): they
have no rollout flag and always cross the bus and its confirmation, by
design. A correctness or security problem there is fixed in code, not
switched off.

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
  api and the worker whole, so the api and the worker also refuse to boot
  with `REKODA_LOCAL_STORAGE` set, or with either provider URL set to
  anything but that provider's own host (G-72; the exact rules are below).
- **Never `dc down -v`** outside a throwaway machine.
- **Never start Caddy past the edge check:** not `dc up --no-deps caddy`,
  not `--scale edge-check=0`, not `dc start` or `dc restart` on a Caddy an
  `up` left in `created`, not a second compose file beside
  `docker-compose.prod.yml`, and never an edit that scales, deploys,
  replaces, moves or `!reset`s `edge-check` in the compose file (CI refuses
  those). Each would serve a trust list nothing checked (G-74, G-75).
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

### Staging deploys itself; production never does

Staging follows `main`. When the CI workflow succeeds on a push to `main`,
`.github/workflows/deploy-staging.yml` connects to the staging host over SSH
and runs `scripts/deploy-staging.sh <sha>` there, for the exact commit CI
passed. It deploys that commit, never the newest `main`, and never a commit
that is not on `origin/main`. It can also be started by hand from the Actions
tab (`workflow_dispatch`), run from `main`, with a full SHA of a commit on
`main`. Production has no
such workflow and is deployed by hand, by tag, with "Deploy a release" above.

The script that runs on the host (the driver) is always a revision that has
passed CI on `main`, and never an older commit's copy, which may be older and
less careful:

- **After CI**, the driver is the commit CI just passed, which is also the
  commit deployed. It runs with `--newer-only`: the workflow runs one
  deployment at a time but does not keep them in order, so a delayed run for
  an older commit could start after a newer one deployed. If staging already
  runs a newer commit of `main`, the script changes nothing and exits 75, and
  the workflow reports the run as skipped. No failure exits 75.
- **By hand from the Actions tab**, the driver is the tip of `main`. The
  workflow first confirms a successful CI push run on `main` for both the
  commit and the driver.

The script is "Deploy a release" for a commit instead of a tag, with the
release named `staging-<short sha>` (`git rev-parse --short=7`: at least
seven characters, more when seven would be ambiguous; `REKODA_RELEASE` and
the build's `REKODA_COMMIT` from the same value). In order, from
`/opt/rekoda`: refuse a checkout with tracked local modifications, refuse a
checkout holding any path no commit has (ignored by git or not) other than
the host-local ones `.dockerignore` keeps out of every image (`.env` and
`.env.*` at any depth, `secrets/`, `data/`, `uploads/`, `storage/`, `logs/`,
`backups/`, a top-level `*.log`), because the build context is the checkout
and anything else would be built into staging without CI having seen it,
refuse a host whose `.env` does not name `https://staging-api.myrekoda.com` as
`REKODA_API_PUBLIC_URL`, refuse unless `/health` answers `status` ok,
`database` up, the `REKODA_RELEASE` in `.env`, and a commit of at least
seven characters that the checked-out commit starts with (the running
release is the one a failure's rollback would name, not merely what the
checkout and `.env` claim), `git fetch --prune origin`, refuse a commit whose
code does not know the schema staging already has (one missing a migration
tag the running commit carries, or carrying fewer migrations than `/health`
says the database has applied: `/health` asks only for the build's own
migrations, so it would read ok even after a later contraction removed what
the older code uses; a rollback across a migration is done by hand, as "Roll
back" says), check out the commit
(detached), change only the `REKODA_RELEASE` line of `.env`, `dc build`,
`dc run --rm -T migrate`, `dc up -d --wait --wait-timeout 300`, reload the
Caddyfile, confirm the edge network, and require
`https://staging-api.myrekoda.com/health` to answer `status` ok, `database`
up, and this release and commit. It ends with `dc ps`. The workflow then asks
`/health` the same question from outside, through Cloudflare. CI
(`scripts/check-staging-deploy.mjs`) fails a pull request that changes a
command in "Deploy a release" without changing the script to match, or that
takes away one of the properties above.

What a failure leaves:

- **Before migrate** (a refused check, a failed fetch or build): nothing
  live changed. The script puts the checkout and `REKODA_RELEASE` back to the
  running release, so the host is as it was.
- **At or after migrate:** the stack may be part-way to the new release.
  The script prints the exact rollback commands (the previous commit and
  release) and `dc ps -a`, and exits non-zero. Read `dc logs <service>` on the
  host; the workflow log never holds container logs. Then roll forward with a
  fixed commit, or roll back as "Roll back" says, with the previous commit in
  place of `vPREVIOUS` and `staging-<its short sha>` as the release. Those
  images are still on the host.

Two deployments never overlap: the workflow runs one at a time and waits
rather than cancelling, and the script holds a lock
(`.git/rekoda-deploy-staging.lock`) against a second run on the host,
including one started by hand.

Set up once:

- **On the host:** `jq` and `flock` installed (with `git`, `curl`, Docker and
  Compose); the checkout's `origin` fetchable by the deploy user without a
  prompt; a dedicated SSH key for the workflow in the deploy user's
  `authorized_keys`, used for nothing else. The deploy user can drive Docker,
  which is root on the host, so this key is as powerful as root there: keep
  it only in the GitHub environment, and rotate it by replacing both halves.
  Nothing else lives in `/opt/rekoda` beyond the checkout and the host-local
  paths above (no `node_modules/`, no copied files, no scratch directories);
  `git ls-files --others --directory` there shows what the script would
  refuse.
- **In GitHub,** the `staging` environment holds four secrets and nothing
  else: `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_PRIVATE_KEY` and
  `STAGING_KNOWN_HOSTS`. `STAGING_KNOWN_HOSTS` is the host's `known_hosts`
  line under the same name as `STAGING_HOST`, taken from a machine that has
  already verified the fingerprint against the host's own
  (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host). The
  workflow insists on it (`StrictHostKeyChecking=yes`) and never learns a key
  from the network. Limit the environment's deployment branches to `main`.
  Every application secret stays in `.env` and `secrets/` on the host.

By hand on the host, the same deploy, with the same driver the workflow uses,
is, from `/opt/rekoda`:

```bash
git fetch --prune origin
git show origin/main:scripts/deploy-staging.sh | bash -s -- <40-character sha>
```

Not `bash scripts/deploy-staging.sh`: that runs the copy in the current
checkout, which after a deploy of an older commit is that commit's older
script. Confirm first that CI passed on the tip of `main`, as the workflow
does. The script is one brace group, read whole before it runs, so the
checkout it performs cannot change it mid-run.

## What a production boot refuses

Each process validates its environment before serving anything, and each
failure below is a one-line startup error naming the variable. For the api
and the worker it is in `dc logs api`; for the edge check the `up` itself
only says a dependency failed, and the line is in `dc logs edge-check`:

- **API and worker:** every required variable is shape-checked
  (`loadConfig`); the database roles must not be SUPERUSER or BYPASSRLS;
  `VAULT_KEY` and `MATCH_KEY` must match their enrolled fingerprints;
  `REKODA_TRUSTED_PROXIES` must be set (the compose file sets it);
  neither trust list may be empty or trust effectively the whole internet;
  `PAYSTACK_BASE_URL` and `MONO_BASE_URL` may only be blank or the
  provider's own host, and `REKODA_LOCAL_STORAGE` must be blank;
  `AI_BASE_URL` and the operator OIDC URLs must be public https hosts (not
  localhost, a container name, a private address, or a reserved `.invalid`,
  `.test` or `.example` name);
  `R2_ACCOUNT_ID` must be the 32-hex account id (G-72);
  `REKODA_RELEASE` and `REKODA_COMMIT` must be short tokens;
  each `REKODA_COMMAND_*` must be unset, `1` or `0` (OD-4).
- **The edge** (`edge-check`, before caddy starts): `REKODA_EDGE_PROXIES`
  must not trust effectively the whole internet (G-74), nor name
  `private_ranges` or any range holding the edge network's gateway,
  172.30.10.1 (G-75): Docker hands Caddy every IPv6 visitor and every
  hairpin connection from that address, so trusting it would let them
  choose their own. `up` fails and Caddy never serves otherwise. On a real
  host set it to Cloudflare's ranges or leave it empty.
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
- [ ] `docker network inspect rekoda-prod_edge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}} {{.EnableIPv6}}'` prints `172.30.10.1 false` (the gateway the edge check refuses, G-75)
- [ ] Worker: `job runner started` in its log, and no growing `pending` backlog
- [ ] Send a WhatsApp message to the Rekoda number; the reply arrives
- [ ] Dashboard sign-in completes
- [ ] `SELECT max(created_at) FROM external_events` is recent (webhooks flowing)
- [ ] Trial-balance job: zero drift rows
