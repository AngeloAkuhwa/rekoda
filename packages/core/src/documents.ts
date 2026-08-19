/**
 * The document snapshot and its hash (MASTER-PLAN §5.3.5 step 7, spec §42).
 *
 * An invoice is immutable, and "immutable" has to mean something checkable. The
 * hash is what a merchant — or a tax officer, or a court — can use to say that
 * the document in front of them is the document that was issued, byte for byte.
 *
 * Held back from the barrel with `identity`, `privacy` and `vault`, because it
 * imports `node:crypto`.
 */
import { createHash } from 'node:crypto';

/**
 * JSON with every object's keys in sorted order, recursively.
 *
 * `JSON.stringify` is NOT canonical: it emits keys in insertion order, so the
 * same document built by two code paths — or by the same code after a
 * refactor moved a field — serialises differently and hashes differently. A
 * hash that changes when nothing about the document changed is worse than no
 * hash, because the first time it happens somebody concludes the record was
 * tampered with.
 *
 * Numbers are all integer kobo by the time they reach here, so there is no
 * float formatting to disagree about.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` has no JSON representation; including it would emit a key
    // with no value and produce invalid JSON.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

/** SHA-256 of the canonical form, hex. */
export function documentHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalise(snapshot), 'utf8').digest('hex');
}

export interface SnapshotItem {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceK: number;
  readonly lineTotalK: number;
}

/**
 * Exactly what the document says, and nothing about how it was produced.
 *
 * No timestamps beyond the issue date, no row ids, no model name, no job id.
 * Two things follow. The hash stays stable across a replay or a restore, which
 * is the point. And the snapshot holds no PII — the customer is a TOKEN, so
 * this column can be read by anyone debugging a document without reading a
 * merchant's customer list.
 */
export interface DocumentSnapshot {
  readonly documentNumber: string;
  readonly issuedAtIso: string;
  readonly customerToken: string | null;
  readonly items: readonly SnapshotItem[];
  readonly subtotalK: number;
  readonly discountK: number;
  readonly deliveryFeeK: number;
  readonly vatK: number;
  readonly totalK: number;
  readonly paidK: number;
  readonly balanceDueK: number;
  readonly currency: string;
}

export function snapshotHash(snapshot: DocumentSnapshot): string {
  return documentHash(snapshot);
}
