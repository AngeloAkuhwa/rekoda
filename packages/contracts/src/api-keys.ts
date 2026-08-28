/**
 * Managing public-API credentials, on the wire (canonical spec §27).
 *
 * These are the DASHBOARD's shapes — how a merchant registers an application
 * and mints, lists and revokes its keys, under an ordinary session. The
 * public API's own contracts are a separate, independently versioned surface
 * (PR-110); nothing here is part of it.
 *
 * §27's rule holds all the same: no Drizzle table shape crosses this
 * boundary. `token_hash` has no field, `business_id` has no field because the
 * session already decided it, and the plaintext token appears in exactly one
 * response and never again.
 */
import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });

export const apiApplicationView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(['active', 'disabled']),
  createdAt: isoDate,
});
export type ApiApplicationView = z.infer<typeof apiApplicationView>;

export const apiKeyView = z.object({
  id: z.string().uuid(),
  applicationId: z.string().uuid(),
  /** The public half. Enough to recognise a key, useless as a credential. */
  prefix: z.string(),
  label: z.string().nullable(),
  rateLimitPerMinute: z.number().int().positive(),
  lastUsedAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type ApiKeyView = z.infer<typeof apiKeyView>;

export const createApiApplicationRequest = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreateApiApplicationRequest = z.infer<typeof createApiApplicationRequest>;

export const createApiKeyRequest = z.object({
  label: z.string().trim().min(1).max(80).nullish(),
  /** Optional expiry. A key that must outlive a contract can say so. */
  expiresAt: isoDate.nullish(),
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequest>;

/**
 * The one response carrying a secret.
 *
 * `token` is returned here and stored nowhere. A merchant who loses it mints
 * another and revokes this one, which is the only honest recovery path for a
 * credential the platform cannot read back.
 */
export const createApiKeyResponse = z.object({
  key: apiKeyView,
  token: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponse>;

export const apiApplicationListResponse = z.object({
  applications: z.array(apiApplicationView),
  keys: z.array(apiKeyView),
});
export type ApiApplicationListResponse = z.infer<typeof apiApplicationListResponse>;
