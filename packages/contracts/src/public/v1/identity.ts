/**
 * `GET /api/v1/identity` — who this key speaks for (canonical spec §27).
 *
 * The smallest useful response, and it exists so a developer can prove their
 * key works before writing anything that depends on it. It names the business
 * the key resolved to, so a key pasted into the wrong environment fails
 * loudly here rather than in a write to the wrong books.
 *
 * Note what is NOT here: no id from any table this response did not come to
 * describe, no plan internals, no counts. §27 forbids exposing table shapes,
 * and the cheapest way to keep that true is to make every public response
 * answer one question.
 */
import { z } from 'zod';

export const publicIdentityResponse = z.object({
  businessId: z.string().uuid(),
  businessName: z.string(),
  applicationId: z.string().uuid(),
  /** The public half of the presented key. Useless as a credential. */
  keyPrefix: z.string(),
  rateLimitPerMinute: z.number().int().positive(),
});
export type PublicIdentityResponse = z.infer<typeof publicIdentityResponse>;
