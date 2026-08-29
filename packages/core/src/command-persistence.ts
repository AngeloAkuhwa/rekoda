/**
 * The ONE boundary between a command and the `command_drafts` table
 * (launch remediation R5).
 *
 * Some command fields are TRANSIENT by contract: the merchant reads them
 * once in the preview and Rekoda keeps no copy, because they are a
 * customer's words — a delivery address, a timing instruction — with no
 * bookkeeping purpose and real liability. That promise used to be
 * enforced by whichever call site remembered it, which is how
 * `RecordPurchase.supplierMention` got stripped and `RecordOrder.note`
 * did not: an isolated `if` per command is a privacy boundary that decays
 * one new intent at a time.
 *
 * So the policy lives here, in one table, and the draft repository
 * applies it to EVERY write. A new command type persists exactly what
 * this file says it may; a command type with no entry persists as-is,
 * which is correct for commands whose every field is bookkeeping data
 * (amounts, quantities, tokens, references).
 *
 * This sanitises for PERSISTENCE only. The preview the merchant reads is
 * built from the live command BEFORE this runs, so "echoed back once and
 * never stored" stays true in both halves.
 */

type CommandRecord = Record<string, unknown>;

/**
 * Per-intent transient fields, nulled before storage.
 *
 * Nulled rather than deleted so the stored JSON keeps the contract's
 * shape and every reader of a draft parses it the same way a fresh
 * command parses.
 */
const TRANSIENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  /* The customer's delivery/timing words. Contract: "Echoed back to the
   * merchant once and never stored." The address is already on the
   * merchant's phone; a copy here is liability, not bookkeeping. */
  RecordOrder: ['note'],
  /* The supplier's raw name. The handler resolves it to a vault row and
   * stores the opaque supplierId instead (ADR 0005, migration 0050);
   * this boundary guarantees the name itself cannot slip through even
   * if a future call site forgets the resolution step. */
  RecordPurchase: ['supplierMention'],
};

export function sanitizeCommandForPersistence(command: unknown): unknown {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    return command;
  }
  const record = command as CommandRecord;
  const intent = record['intent'];
  const transient = typeof intent === 'string' ? TRANSIENT_FIELDS[intent] : undefined;
  if (!transient || transient.length === 0) return command;

  const dirty = transient.some((field) => field in record && record[field] !== null);
  if (!dirty) return command;

  const sanitised: CommandRecord = { ...record };
  for (const field of transient) {
    if (field in sanitised && sanitised[field] !== null) sanitised[field] = null;
  }
  return sanitised;
}
