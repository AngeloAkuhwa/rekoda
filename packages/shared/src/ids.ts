/**
 * Branded identifier types — architecture spec §7.
 *
 * A magic-link token is an authentication artefact. A customer token is a
 * pseudonym for a person. A session id is neither. The spec's hard rule is
 * that these must NEVER mix, so each is a distinct nominal type: assigning a
 * MagicLinkToken where a CustomerToken is expected is a compile error, not a
 * code-review hope.
 *
 * The runtime representation is a plain string; the brand exists only in the
 * type system and costs nothing.
 */

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/* ── tenancy ── */
export type BusinessId = Brand<string, 'BusinessId'>;
export type UserId = Brand<string, 'UserId'>;
export type MembershipId = Brand<string, 'MembershipId'>;

/* ── pseudonymous customer identity (privacy gateway) ── */
/** Opaque customer pseudonym, e.g. "CUSTOMER_X81". Safe to show to AI. */
export type CustomerToken = Brand<string, 'CustomerToken'>;
/** Primary key of the customer row. Internal; carries no identity. */
export type CustomerId = Brand<string, 'CustomerId'>;

/* ── authentication artefacts — never PII, never interchangeable ── */
/** Single-use dashboard access token (the /access/{token} path segment). */
export type MagicLinkToken = Brand<string, 'MagicLinkToken'>;
export type SessionId = Brand<string, 'SessionId'>;
export type OtpChallengeId = Brand<string, 'OtpChallengeId'>;
/** Reference to an encrypted provider credential in the connections vault. */
export type ApiKeyRef = Brand<string, 'ApiKeyRef'>;

/* ── financial documents ── */
export type InvoiceId = Brand<string, 'InvoiceId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type PaymentId = Brand<string, 'PaymentId'>;
export type ExpenseId = Brand<string, 'ExpenseId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type SupplierId = Brand<string, 'SupplierId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
export type ExternalEventId = Brand<string, 'ExternalEventId'>;

/** Cast helper for boundaries (DB rows, request params) — the ONLY sanctioned
 * way to mint a branded id. Grep for `asId(` to audit every entry point. */
export const asId = <T extends string>(value: string): Brand<string, T> =>
  value as Brand<string, T>;
