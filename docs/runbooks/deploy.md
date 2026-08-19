# Runbook — Deploy & Rollback

Target: single Hetzner box, Docker Compose, Caddy in front (ADR 0006).
Deploys are tagged releases; `main` is always deployable.

## First-time server setup

1. Hetzner CPX31, Ubuntu LTS. Create non-root user; SSH keys only
   (`PasswordAuthentication no`); ufw allow 22/80/443 only.
2. Install Docker + compose plugin. `docker login` not needed (images build
   on-box at V1).
3. Clone the repo to `/opt/rekoda`; copy `.env.example` → `.env` and fill —
   generate every key with `openssl rand -hex 32`.
4. Point DNS at Cloudflare (proxied); Caddy obtains origin TLS automatically.
5. `docker compose up -d` → run migrations (below) → smoke-check `/health`.

## Deploy a release

```bash
ssh rekoda@server
cd /opt/rekoda
git fetch --tags && git checkout vX.Y.Z     # never deploy a branch tip
docker compose build                        # build BEFORE touching anything live
docker compose run --rm api pnpm --filter @rekoda/db migrate   # expand-only migrations
docker compose up -d                        # atomic swap
curl -fsS https://rekoda.app/health         # must return ok
```

Migration discipline: **expand → deploy → contract.** A migration in the
same release as the code that needs it must be backward-compatible with the
previous release (additive columns/tables). Destructive contractions ship
one release later.

## Rollback

```bash
git checkout vX.Y.(Z-1)
docker compose build && docker compose up -d
```

Because migrations are expand-only, the previous release runs against the
newer schema. If a bad migration itself must be reverted, restore from
backup (see backup-restore.md) — which is why financial-table migrations
are drilled before they ship.

## Smoke checklist after every deploy

- [ ] `/health` returns ok and the release version
- [ ] Send a WhatsApp message to the Rekoda number → reply arrives
- [ ] Dashboard magic-link flow completes
- [ ] `SELECT 1 FROM external_events ORDER BY created_at DESC LIMIT 1` is recent (webhooks flowing)
- [ ] Trial-balance job: zero drift rows
