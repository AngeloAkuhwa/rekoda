/**
 * The identity wire contract (spec §36).
 *
 * Both `apps/api` and `apps/web` parse against these, so a field renamed on one
 * side fails to compile on the other rather than becoming `undefined` at
 * runtime in front of a merchant.
 *
 * Naira never appears here. Nothing in this file carries money.
 */
import { z } from 'zod';

/** E.164 Nigerian mobile. Normalisation itself lives in `@rekoda/core`. */
export const phoneSchema = z.string().min(4).max(20);

export const requestOtpRequest = z.object({ phone: phoneSchema });
export type RequestOtpRequest = z.infer<typeof requestOtpRequest>;

export const requestOtpResponse = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('sent'),
    phone: z.string(),
    /**
     * Present ONLY when the API is explicitly running with OTP reveal enabled,
     * which production never does. It exists so end-to-end tests can complete
     * the flow without a WhatsApp account, and it is absent from every other
     * build. The e2e suite asserts that absence.
     */
    devCode: z.string().optional(),
  }),
  z.object({ status: z.literal('resend_too_soon'), phone: z.string(), retryInSeconds: z.number() }),
  z.object({ status: z.literal('locked_out'), phone: z.string() }),
]);
export type RequestOtpResponse = z.infer<typeof requestOtpResponse>;

export const verifyOtpRequest = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type VerifyOtpRequest = z.infer<typeof verifyOtpRequest>;

export const membershipSummary = z.object({
  businessId: z.string().uuid(),
  businessName: z.string(),
  role: z.string(),
});
export type MembershipSummary = z.infer<typeof membershipSummary>;

export const verifyOtpResponse = z.discriminatedUnion('status', [
  /** Verified, and the merchant already has at least one business. */
  z.object({
    status: z.literal('signed_in'),
    sessionToken: z.string(),
    expiresAt: z.string(),
    memberships: z.array(membershipSummary).min(1),
  }),
  /**
   * Verified, but there is no business yet. A session cannot be issued — a
   * session is bound to a business by definition — so the caller gets a
   * narrow, short-lived grant that authorises exactly one thing: creating one.
   */
  z.object({
    status: z.literal('setup_required'),
    setupToken: z.string(),
    expiresAt: z.string(),
  }),
  z.object({ status: z.literal('wrong_code'), attemptsLeft: z.number() }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('already_used') }),
  z.object({ status: z.literal('too_many_attempts') }),
  z.object({ status: z.literal('locked_out') }),
]);
export type VerifyOtpResponse = z.infer<typeof verifyOtpResponse>;

/**
 * CAC and TIN are deliberately absent, and must stay absent.
 *
 * Most small vendors have neither, and requiring either would exclude
 * exactly the merchants Rekoda exists for (spec §20, ADR 0012). Capture them
 * later, from settings, when the merchant offers them.
 */
export const createBusinessRequest = z.object({
  name: z.string().trim().min(2).max(80),
  businessType: z.string().trim().min(2).max(60).nullable(),
});
export type CreateBusinessRequest = z.infer<typeof createBusinessRequest>;

export const sessionResponse = z.object({
  sessionToken: z.string(),
  expiresAt: z.string(),
  businessId: z.string().uuid(),
  businessName: z.string(),
  role: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponse>;

export const meResponse = z.object({
  userId: z.string().uuid(),
  phone: z.string(),
  businessId: z.string().uuid(),
  businessName: z.string(),
  businessType: z.string().nullable(),
  plan: z.string(),
  role: z.string(),
});
export type MeResponse = z.infer<typeof meResponse>;

export const healthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.enum(['up', 'down']),
  /** Names of migrations recorded as applied — empty means the schema is bare. */
  migrations: z.number(),
});
export type HealthResponse = z.infer<typeof healthResponse>;

/**
 * What a setup grant proves. Lets the web tier guard the business-setup step
 * server-side instead of trusting the presence of a cookie it cannot verify —
 * only the API holds the signing secret.
 */
export const setupStateResponse = z.object({
  phone: z.string(),
  expiresAt: z.string(),
});
export type SetupStateResponse = z.infer<typeof setupStateResponse>;
