/**
 * The part of a Resend webhook event Rekoda reads (N7). Minimal on purpose: the signature is
 * the admission check, and an event with a field we do not know is still readable.
 */
import { z } from 'zod';

export const resendWebhookEvent = z.object({
  type: z.string(),
  data: z
    .object({
      to: z.array(z.string()).max(50).optional(),
      bounce: z.object({ type: z.string().optional() }).optional(),
    })
    .optional(),
});
export type ResendWebhookEvent = z.infer<typeof resendWebhookEvent>;
