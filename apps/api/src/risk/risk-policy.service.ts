/**
 * The one place a command is authorised (canonical spec Appendix D).
 *
 * Appendix D.3: "Every front door obeys the same tiers... No alternate
 * ingress gets a cheaper safety path, which is the entire reason the tier
 * lives on the command rather than on the controller."
 *
 * So this service takes a COMMAND NAME and never a tier. There is no
 * parameter an ingress could pass to make a refund cheap, no allowlist, and
 * no override. A controller that wants a different answer has to change the
 * table in `@rekoda/core`, in a diff somebody reviews.
 *
 * It exists before the command layer of §25 does. A1 will move the call site
 * into the dispatcher; the policy does not move, because the policy was never
 * the dispatcher's. Until then every ingress calls this directly, which is
 * exactly what "a shared server-side concern" means.
 */
import { Injectable } from '@nestjs/common';
import {
  CONFIRMATION_TTL_SECONDS,
  riskOf,
  type Ingress,
  type RiskContext,
  type RiskTier,
} from '@rekoda/core';
import { riskRepo, type TenantDb } from '@rekoda/db';

/** What an ingress knows about the request it is holding. */
export interface CommandRequest {
  businessId: string;
  command: string;
  /** Which refund, which period, which connection. */
  subject?: string | null;
  /** The authenticated actor. `system` and `webhook:*` are actors too. */
  actor: string;
  ingress: Ingress;
  /** Facts about this invocation that can RAISE its tier, never lower it. */
  context?: RiskContext;
  /**
   * The confirmation the merchant already gave, for a HIGH_RISK command.
   * Absent means they have not been asked yet.
   */
  confirmationId?: string | null;
}

export type RiskDecision =
  | { readonly outcome: 'allowed'; readonly tier: RiskTier }
  /** The away assistant, holding something it may never do by itself. */
  | { readonly outcome: 'refused'; readonly reason: 'away_assistant_forbidden' }
  /** Ask the merchant, naming the consequence, then come back with the id. */
  | { readonly outcome: 'confirm_first'; readonly tier: 'HIGH_RISK' }
  | { readonly outcome: 'confirmation_expired' }
  | { readonly outcome: 'confirmation_already_used' }
  | { readonly outcome: 'confirmation_invalid' };

@Injectable()
export class RiskPolicyService {
  /** How long a confirmation stands. Exposed so an ingress can say so. */
  readonly ttlSeconds = CONFIRMATION_TTL_SECONDS;

  /** What this command demands, with no side effects. Safe to ask twice. */
  tierFor(command: string, context: RiskContext = {}): RiskTier {
    return riskOf(command, context);
  }

  /**
   * Open a confirmation, having shown the merchant the consequence.
   *
   * `consequence` is the sentence they read, kept because the audit event
   * should record what somebody agreed to rather than what a later reader
   * assumes they were shown. `reason` is required by Appendix D.3 and by the
   * column, so a caller cannot leave it blank on either side.
   */
  ask(
    tx: TenantDb,
    input: {
      businessId: string;
      command: string;
      subject?: string | null;
      actor: string;
      ingress: Ingress;
      consequence: string;
      reason: string;
      context?: Record<string, unknown> | null;
      now?: Date;
    },
  ): Promise<riskRepo.ConfirmationRow> {
    const from = input.now ?? new Date();
    return riskRepo.openConfirmation(tx, {
      businessId: input.businessId,
      command: input.command,
      subject: input.subject ?? null,
      actor: input.actor,
      ingress: input.ingress,
      consequence: input.consequence,
      reason: input.reason,
      context: input.context ?? null,
      expiresAt: new Date(from.getTime() + this.ttlSeconds * 1_000),
    });
  }

  /**
   * May this request proceed?
   *
   * The order is the whole policy, and it is the same order for every front
   * door:
   *
   * 1. The away assistant is refused anything HIGH_RISK, before anything
   *    else is even looked at. Appendix D.3 makes that absolute "including
   *    when the merchant has performed that same action manually before",
   *    so there is nothing to look up and nothing that could change it.
   * 2. READ_ONLY and STANDARD proceed. STANDARD's preview-and-yes is the
   *    existing draft mechanism and lives where the draft does.
   * 3. HIGH_RISK needs a confirmation this merchant gave, for this command,
   *    on this subject, from this front door, unspent and unexpired.
   */
  async authorise(tx: TenantDb, request: CommandRequest, now = new Date()): Promise<RiskDecision> {
    const tier = riskOf(request.command, request.context ?? {});

    if (request.ingress === 'AWAY_ASSISTANT' && tier === 'HIGH_RISK') {
      return { outcome: 'refused', reason: 'away_assistant_forbidden' };
    }

    if (tier !== 'HIGH_RISK') return { outcome: 'allowed', tier };

    if (!request.confirmationId) return { outcome: 'confirm_first', tier };

    const claim = await riskRepo.claimConfirmation(tx, {
      businessId: request.businessId,
      id: request.confirmationId,
      command: request.command,
      subject: request.subject ?? null,
      actor: request.actor,
      ingress: request.ingress,
      now,
    });

    switch (claim.outcome) {
      case 'claimed':
        /* The audit event is the caller's, written in the same transaction
         * as the thing it describes: an audit row committed beside a rolled
         * back refund is a record of something that did not happen. What
         * this service guarantees is that the claim and the execution share
         * a transaction, which is why `tx` is the caller's. */
        return { outcome: 'allowed', tier };
      case 'expired':
        return { outcome: 'confirmation_expired' };
      case 'already_used':
        return { outcome: 'confirmation_already_used' };
      case 'not_found':
        return { outcome: 'confirmation_invalid' };
    }
  }
}
