/**
 * Where a sale actually happened (docs/rekoda-chat-v1.md §27–29).
 *
 * Two facts the domain refuses to blur:
 *
 *   sale_source   where the money was earned: the shop counter, an Instagram
 *                 DM, a phone order, the WhatsApp catalogue.
 *   captured via  how the event reached Rekoda: a Rekoda Chat conversation
 *                 or a Rekoda Integrate webhook (the existing source_type).
 *
 * "Captured via chat" does NOT mean "sold on WhatsApp". WhatsApp is the
 * interface; the merchant sells anywhere. The source is OPTIONAL by design:
 * Rekoda never demands it per transaction, and only records it when the
 * merchant names a channel ("Sandra bought 2 wigs from my Instagram page")
 * or a connected system supplies it (a catalogue order is, by construction,
 * whatsapp_catalogue).
 */
export const SALE_SOURCES = [
  'physical_store',
  'instagram',
  'facebook',
  'tiktok',
  'whatsapp_catalogue',
  'website',
  'phone',
  'marketplace',
  'event',
  'other',
] as const;

export type SaleSource = (typeof SALE_SOURCES)[number];

export function isSaleSource(value: unknown): value is SaleSource {
  return typeof value === 'string' && (SALE_SOURCES as readonly string[]).includes(value);
}
