/**
 * Recording a refund of one of Rekoda's own charges (ADR 0024; migration 0230), free of any web
 * framework, on the billing-operator database principal (`rekoda_billing_operator`) and nowhere else.
 *
 * Only that principal may run `subscription_record_refund`, and the dedicated operator process
 * holds it (OD-51.1): it verifies the operator's identity and `ops:payment` scope itself, so the
 * application credential the API holds can no longer record a refund. `actor` is the verified
 * `operator:<subject>`, never a value from the body. The function records the fact (it moves no
 * money: the naira goes back through Paystack, by the operator), writes the audit event, and for a
 * credited pack refuses anything but a full refund of an unused pack within seven days and revokes
 * that pack's units in the same transaction.
 *
 * Kept apart from the controllers so the operator process and the API's development route run the
 * same code.
 */
import { opsRefundRequest } from '@rekoda/contracts';
import { subscriptionsRepo, type Db } from '@rekoda/db';
import { OperatorPlaneRefusal } from './plan-operations.js';

export async function recordRefundAsOperator(
  operatorDb: Db,
  actor: string,
  body: unknown,
): Promise<{ refunded: true; status: string; refundedK: number; revokedUnits: number }> {
  const input = opsRefundRequest.safeParse(body);
  if (!input.success) {
    throw new OperatorPlaneRefusal(
      400,
      'businessId, reference, amountK (positive kobo) and reason are required',
    );
  }
  try {
    const recorded = await subscriptionsRepo.recordRefund(operatorDb, { ...input.data, actor });
    return { refunded: true as const, ...recorded };
  } catch (error) {
    if (error instanceof subscriptionsRepo.RefundRefused) {
      throw new OperatorPlaneRefusal(400, error.message);
    }
    throw error;
  }
}
