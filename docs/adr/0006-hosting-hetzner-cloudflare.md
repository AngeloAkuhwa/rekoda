# 0006 — Hosting: Hetzner + Cloudflare + R2 (no Azure)

**Status:** Accepted
**Date:** 2026-08-19

## Context

The early pricing analysis budgeted ₦75–150k/month on Azure. The owner has
ruled Azure out on cost. V1 needs: one Postgres, a Node API, a Next.js app,
an STT container, object storage for generated PDFs (frequently
_downloaded_ — egress matters), TLS, CDN and backups. Everything is
containerised, so the choice must be reversible.

## Decision

- **Hetzner Cloud CPX31** (4 vCPU / 8 GB, EU) running Docker Compose:
  Caddy → web + api + stt + Postgres. ~€13.6/month.
- **Cloudflare free tier** in front: CDN for Nigerian latency, WAF, TLS,
  DDoS protection.
- **Cloudflare R2** for documents/exports — S3-compatible with **zero
  egress fees**.
- **Backblaze B2** for nightly encrypted Postgres dumps + document backups;
  Hetzner snapshots for whole-box restore.
- All-in at launch: **~₦30–40k/month** — roughly four Chat subscriptions.

## Consequences

Infrastructure is a rounding error until it deserves to be more. EU→Lagos
latency is irrelevant for webhooks (Meta/Paystack call us) and masked by
Cloudflare for the dashboard. Scaling path is boring on purpose: vertical
resize (CPX41/51) → Postgres to its own instance or managed
(Neon/DO) → split app/STT boxes. Single-box risk is accepted at V1 and
mitigated by tested restore runbooks (RPO: nightly dump + WAL if needed;
restore drill documented in `docs/runbooks/`). Revisit when paying-merchant
count makes an hour of downtime cost more than the redundancy.
