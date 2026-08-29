/**
 * The erasure command (spec Appendix D.2; PR-027): `EraseData`.
 *
 * The one command whose confirmation is an exact PHRASE, never a yes: a yes
 * is a reflex on a phone in a shop; typing five words is a decision, and
 * erasing a merchant's customers is not undoable by anybody. Chat's
 * deterministic router IS the phrase check — only the literal phrase routes
 * here twice — and the pending confirmation records what the merchant was
 * told they were agreeing to.
 *
 * The announcement carries the COUNT and nothing else: an event about
 * erasure that carried anything identifying would be the contradiction of
 * the act it describes.
 */
import { customersRepo, outboxRepo, type TenantDb } from '@rekoda/db';

export interface EraseDataInput {
  businessId: string;
  /** Which door asked, for the audit trail the deletion leaves behind. */
  sourceType: string;
}

export async function eraseDataWork(
  tx: TenantDb,
  input: EraseDataInput,
): Promise<{ erased: number }> {
  const erased = await customersRepo.eraseAllIdentities(tx, input.businessId, input.sourceType);

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'data.erased',
    payload: { erased, sourceType: input.sourceType },
  });

  return { erased };
}
