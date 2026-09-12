# syntax=docker/dockerfile:1

# Rekoda's production images (G-01). Two targets from one build:
#
#   app  The API and the worker, and the deploy's migrate job. One image, two
#        roles chosen by REKODA_WORKER at run time, so a job handler cannot be
#        present in one and missing from the other (apps/api/src/jobs).
#   web  The Next.js site, built with its public NEXT_PUBLIC_* values.
#
# Built by docker-compose.prod.yml; operated by docs/runbooks/deploy.md.
# Nothing secret is an argument or a layer: .env and secrets/ are outside the
# build context (.dockerignore), the only build arguments are the release
# label and the site's public values, and scripts/check-deploy.mjs fails CI
# if either rule is broken.

# The Node major in .nvmrc; scripts/check-deploy.mjs fails CI if they differ.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    CI=1
RUN corepack enable
WORKDIR /repo

# Every dependency, resolved from the lockfile alone, so this layer survives
# any change that does not touch the lockfile.
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM fetch AS source
COPY . .
RUN pnpm install --offline --frozen-lockfile

# pnpm links workspace packages by absolute path, so each production copy is
# made at the path it will run from (/app) and copied across unchanged.
# Pruned afterwards: sources, compiled tests, the db test harness, build
# caches and tool configs are not part of what runs.
FROM source AS app-build
RUN pnpm turbo run build --filter=@rekoda/api...
RUN pnpm --filter @rekoda/api --prod --offline deploy /app
RUN set -eu; \
    cd /app; \
    for dir in /app node_modules/.pnpm/@rekoda+*/node_modules/@rekoda/*; do \
      rm -rf "$dir/src" "$dir/.turbo" "$dir"/tsconfig*.json "$dir"/vitest*.ts "$dir/drizzle.config.ts"; \
      if [ -d "$dir/dist" ]; then \
        find "$dir/dist" \( -name '*.test.*' -o -name 'testing.*' \) -delete; \
      fi; \
    done

# The public values are inlined into the site at `next build`, so they are
# build arguments here and baked into the image below: the legal gate at
# `next start` then checks exactly the values the pages show. A web image
# cannot be built without the mandatory legal facts.
FROM source AS web-build
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_REKODA_WHATSAPP
ARG NEXT_PUBLIC_LEGAL_ENTITY
ARG NEXT_PUBLIC_LEGAL_RC_NUMBER
ARG NEXT_PUBLIC_LEGAL_ADDRESS
ARG NEXT_PUBLIC_PRIVACY_EMAIL
ARG NEXT_PUBLIC_SUPPORT_EMAIL
ARG NEXT_PUBLIC_NDPR_AUDITOR
ARG NEXT_PUBLIC_MONO_PUBLIC_KEY
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_REKODA_WHATSAPP=${NEXT_PUBLIC_REKODA_WHATSAPP} \
    NEXT_PUBLIC_LEGAL_ENTITY=${NEXT_PUBLIC_LEGAL_ENTITY} \
    NEXT_PUBLIC_LEGAL_RC_NUMBER=${NEXT_PUBLIC_LEGAL_RC_NUMBER} \
    NEXT_PUBLIC_LEGAL_ADDRESS=${NEXT_PUBLIC_LEGAL_ADDRESS} \
    NEXT_PUBLIC_PRIVACY_EMAIL=${NEXT_PUBLIC_PRIVACY_EMAIL} \
    NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL} \
    NEXT_PUBLIC_NDPR_AUDITOR=${NEXT_PUBLIC_NDPR_AUDITOR} \
    NEXT_PUBLIC_MONO_PUBLIC_KEY=${NEXT_PUBLIC_MONO_PUBLIC_KEY}
RUN node --input-type=module -e " \
      import { missingLegalVars } from './apps/web/legal-gate.mjs'; \
      const missing = missingLegalVars(process.env); \
      if (!process.env.NEXT_PUBLIC_SITE_URL) missing.unshift('NEXT_PUBLIC_SITE_URL'); \
      if (missing.length > 0) { \
        console.error('refusing to build the site without: ' + missing.join(', ')); \
        process.exit(1); \
      }"
RUN pnpm turbo run build --filter=@rekoda/web...
RUN pnpm --filter @rekoda/web --prod --offline deploy /app
RUN set -eu; \
    cd /app; \
    rm -rf src e2e test-results playwright-report .turbo .next/cache \
      tsconfig.json tsconfig.tsbuildinfo next-env.d.ts vitest.config.ts playwright.config.ts \
      legal-gate.d.mts

FROM node:${NODE_VERSION}-bookworm-slim AS app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=app-build /app /app
COPY deploy/migrate.sh /app/deploy/migrate.sh
ARG REKODA_RELEASE
ARG REKODA_COMMIT=unknown
RUN test -n "${REKODA_RELEASE}" || { echo 'build with REKODA_RELEASE set (the release tag)' >&2; exit 1; }
ENV REKODA_RELEASE=${REKODA_RELEASE} \
    REKODA_COMMIT=${REKODA_COMMIT}
LABEL org.opencontainers.image.title="rekoda-app" \
      org.opencontainers.image.version="${REKODA_RELEASE}" \
      org.opencontainers.image.revision="${REKODA_COMMIT}"
# The code is owned by root and run by `node`: the process cannot rewrite
# what it runs.
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]

FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=web-build /app /app
# Next writes its runtime cache under .next; everything else stays root's.
RUN chown -R node:node /app/.next
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_REKODA_WHATSAPP
ARG NEXT_PUBLIC_LEGAL_ENTITY
ARG NEXT_PUBLIC_LEGAL_RC_NUMBER
ARG NEXT_PUBLIC_LEGAL_ADDRESS
ARG NEXT_PUBLIC_PRIVACY_EMAIL
ARG NEXT_PUBLIC_SUPPORT_EMAIL
ARG NEXT_PUBLIC_NDPR_AUDITOR
ARG NEXT_PUBLIC_MONO_PUBLIC_KEY
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
    NEXT_PUBLIC_REKODA_WHATSAPP=${NEXT_PUBLIC_REKODA_WHATSAPP} \
    NEXT_PUBLIC_LEGAL_ENTITY=${NEXT_PUBLIC_LEGAL_ENTITY} \
    NEXT_PUBLIC_LEGAL_RC_NUMBER=${NEXT_PUBLIC_LEGAL_RC_NUMBER} \
    NEXT_PUBLIC_LEGAL_ADDRESS=${NEXT_PUBLIC_LEGAL_ADDRESS} \
    NEXT_PUBLIC_PRIVACY_EMAIL=${NEXT_PUBLIC_PRIVACY_EMAIL} \
    NEXT_PUBLIC_SUPPORT_EMAIL=${NEXT_PUBLIC_SUPPORT_EMAIL} \
    NEXT_PUBLIC_NDPR_AUDITOR=${NEXT_PUBLIC_NDPR_AUDITOR} \
    NEXT_PUBLIC_MONO_PUBLIC_KEY=${NEXT_PUBLIC_MONO_PUBLIC_KEY}
ARG REKODA_RELEASE
ARG REKODA_COMMIT=unknown
LABEL org.opencontainers.image.title="rekoda-web" \
      org.opencontainers.image.version="${REKODA_RELEASE}" \
      org.opencontainers.image.revision="${REKODA_COMMIT}"
USER node
EXPOSE 3000
# `next start`, not the standalone server: standalone inlines the config and
# never evaluates next.config.mjs, which is where the legal gate runs.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
