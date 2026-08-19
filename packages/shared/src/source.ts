/**
 * Source tracking — architecture spec §41.
 * Every financial record remembers how it entered Rekoda.
 */
export const SOURCE_TYPES = [
  'REKODA_CHAT',
  'WHATSAPP_CATALOGUE',
  'PAYSTACK_WEBHOOK',
  'DASHBOARD',
  'ADMIN',
  'SYSTEM',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export interface Source {
  readonly type: SourceType;
  /** Id of the originating record (conversation message, external event…). */
  readonly id: string | null;
}
