/**
 * The role matrix, as the SCREEN reads it (spec §35).
 *
 * Presentation only, and deliberately so: the API's RolesGuard is the
 * enforcement, proven door-by-door in roles.integration.test.ts, so a
 * mistake here can hide a button but never open one. What this file buys is
 * the accounting-tool standard: a view-only member's dashboard reads as the
 * read-only instrument it is, instead of dangling actions that answer with
 * refusals.
 *
 * The names mirror the API's groupings, not the pages, so a page cannot
 * invent its own opinion about what a role means.
 */

/** Owners decide: money out, history rewrites, settings, publishing, team. */
export function isOwner(role: string): boolean {
  return role === 'owner';
}

/**
 * Day-to-day trade: recording customer payments, settling suppliers,
 * counting stock, keeping the catalogue current. Owners and delegates.
 */
export function canRecordTrade(role: string): boolean {
  return role === 'owner' || role === 'delegate';
}

/**
 * Bank reconciliation: importing statements, pairing and unpairing lines.
 * Accountant work that annotates without moving money. Owners and
 * accountants; forgetting a statement day deletes rows and stays the
 * owner's (isOwner).
 */
export function canReconcileBank(role: string): boolean {
  return role === 'owner' || role === 'accountant';
}
