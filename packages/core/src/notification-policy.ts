/**
 * Which channels a notification may use (owner directive, 26 Oct 2026). Pure rules, no IO.
 *
 * Rekoda is WhatsApp-native: WhatsApp is the primary channel and email is an additional one
 * whenever an address that is valid, authorised and not suppressed exists. Nothing here decides
 * whether a channel can actually deliver (the 24-hour window, templates, STOP, suppression and
 * rate limits are checked at send time by the channel's own door); this only decides which
 * channels to TRY, in what order, and whether a purpose may use email at all.
 */

export type NotificationChannel = 'whatsapp' | 'email';

/** Who the message is for and why. The purpose, not the sender, sets the policy. */
export type NotificationPurpose =
  | 'merchant_alert'
  | 'billing_notice'
  | 'security_verification'
  | 'debt_reminder'
  | 'business_activity'
  | 'customer_confirmation';

export interface PurposePolicy {
  /** Channels the purpose may ever use, in order of preference. */
  allowed: readonly NotificationChannel[];
  /**
   * `both`: every available allowed channel, WhatsApp first. `first_available`: only the most
   * preferred available one (a code or a link is not sent twice).
   */
  mode: 'both' | 'first_available';
  /** A merchant may switch this purpose off. Essential and legally required notices may not be. */
  optional: boolean;
}

export const PURPOSE_POLICY: Record<NotificationPurpose, PurposePolicy> = {
  merchant_alert: { allowed: ['whatsapp', 'email'], mode: 'both', optional: true },
  billing_notice: { allowed: ['whatsapp', 'email'], mode: 'both', optional: false },
  security_verification: {
    allowed: ['whatsapp', 'email'],
    mode: 'first_available',
    optional: false,
  },
  debt_reminder: { allowed: ['whatsapp', 'email'], mode: 'both', optional: true },
  business_activity: { allowed: ['whatsapp', 'email'], mode: 'both', optional: true },
  customer_confirmation: { allowed: ['whatsapp', 'email'], mode: 'both', optional: true },
};

export interface ChannelAvailability {
  /** A phone number is on file. It is NOT a promise that the number is messageable. */
  whatsapp: boolean;
  /** An address is on file. The caller has not yet judged consent, verification or suppression. */
  email: boolean;
}

/**
 * The channels to try for one notification event, WhatsApp first.
 *
 * `'auto'` takes the purpose's policy and what is on file. An explicit list is honoured within what
 * the purpose allows, even for a channel with no address, so the refusal is recorded with its true
 * reason instead of being silently dropped. An empty result means neither channel can be tried.
 */
export function planChannels(
  purpose: NotificationPurpose,
  requested: 'auto' | readonly NotificationChannel[],
  available: ChannelAvailability,
): NotificationChannel[] {
  const policy = PURPOSE_POLICY[purpose];
  const ordered = policy.allowed;
  if (requested !== 'auto') {
    return ordered.filter((channel) => requested.includes(channel));
  }
  const usable = ordered.filter((channel) => available[channel]);
  return policy.mode === 'both' ? [...usable] : usable.slice(0, 1);
}
