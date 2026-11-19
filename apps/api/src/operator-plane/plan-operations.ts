/**
 * The operator plan operations, free of any web framework.
 *
 * Two acts, both run on the billing-operator database principal (`rekoda_billing_operator`) and
 * nowhere else: an ordinary assignment, which runs Rekoda's standard period (OD-50, migration
 * 0207), and the resolution of a merchant's support-reviewed upgrade, which keeps the paid-through
 * date exactly as it is (OD-50, migration 0213). The caller has already verified the operator's
 * identity and scope; `actor` is the `operator:<subject>` that verification produced, never a
 * value from the request body.
 *
 * Kept apart from the controllers so the dedicated operator process (OD-51) and the API's
 * development route run the same code.
 */
import {
  resolvePlanReviewRequest,
  setPlanRequest,
  type ResolvePlanReviewResponse,
} from '@rekoda/contracts';
import { billingRepo, type Db } from '@rekoda/db';

/** The caller's mistake, with the HTTP status it maps to. Anything else is a server fault. */
export class OperatorPlaneRefusal extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Move a business onto a plan for its standard period (`POST /v1/businesses/plan`).
 *
 * Rekoda's plan periods (OD-50, migration 0207): a paid plan runs exactly one billing interval
 * from now and a trial exactly to the business's own 14-day trial end, both computed by the
 * database writer, so `expiresAt` is null for them and a date is refused (a 400). `expired` ends
 * now, or at a given time that is not in the future; that is how a plan ends early. The same rule
 * is enforced in the application (`planDateRefusal`) and in the writer.
 */
export async function setPlanAsOperator(
  operatorDb: Db,
  actor: string,
  body: unknown,
): Promise<{ plan: string; changed: boolean }> {
  const parsed = setPlanRequest.safeParse(body);
  if (!parsed.success) {
    throw new OperatorPlaneRefusal(
      400,
      'businessId, plan and expiresAt are required; billingInterval is monthly or annual',
    );
  }
  const { businessId, plan, expiresAt, billingInterval } = parsed.data;
  let changed: boolean | 'unchanged';
  try {
    changed = await billingRepo.setPlan(operatorDb, {
      businessId,
      plan,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      ...(billingInterval ? { billingInterval } : {}),
      actor,
    });
  } catch (error) {
    if (error instanceof billingRepo.PlanDateRefused) {
      throw new OperatorPlaneRefusal(400, error.message);
    }
    /* The writer's own input refusal (the same rule, enforced in the database) is the caller's
     * input too; anything else is not, and stays a 500. */
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (
      cause?.code === '22023' &&
      typeof cause.message === 'string' &&
      cause.message.startsWith('subscription_operator_set_plan:')
    ) {
      throw new OperatorPlaneRefusal(
        400,
        cause.message.replace('subscription_operator_set_plan: ', ''),
      );
    }
    throw error;
  }
  if (!changed) throw new OperatorPlaneRefusal(404, 'no business with that id');
  /* `changed: false` is a re-post of the plan and interval already in force (OD-50): nothing was
   * written, so the period already running stands. */
  return { plan, changed: changed === true };
}

/**
 * Resolve a merchant's support-reviewed upgrade (`POST /v1/businesses/plan/support-review`).
 *
 * The body names the business, the plan and a reason, and nothing else: it is a strict object, so
 * a date (or any other extra field) is a 400, not something quietly ignored. The database function
 * takes no date either; it keeps the paid-through date the merchant already has.
 */
export async function resolvePlanReviewAsOperator(
  operatorDb: Db,
  actor: string,
  body: unknown,
): Promise<ResolvePlanReviewResponse> {
  const parsed = resolvePlanReviewRequest.safeParse(body);
  if (!parsed.success) {
    throw new OperatorPlaneRefusal(
      400,
      'businessId, plan (chat, integrate or complete) and reason are required, and nothing else: a support-review resolution keeps the existing paid-through date, so no date is accepted',
    );
  }
  const { businessId, plan, reason } = parsed.data;
  let resolved: billingRepo.SupportReviewResolution | null;
  try {
    resolved = await billingRepo.resolveSupportReview(operatorDb, {
      businessId,
      plan,
      actor,
      reason,
    });
  } catch (error) {
    if (error instanceof billingRepo.SupportReviewRefused) {
      throw new OperatorPlaneRefusal(400, error.message);
    }
    throw error;
  }
  if (!resolved) throw new OperatorPlaneRefusal(404, 'no business with that id');
  return {
    plan,
    previousPlan: resolved.previousPlan,
    paidThrough: resolved.paidThrough.toISOString(),
    changed: resolved.changed,
  };
}
