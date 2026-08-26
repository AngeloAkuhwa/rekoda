/**
 * One place a command is authorised, de-duplicated and run (spec §25, §26).
 *
 * Spec §25: "Every ingress converges on the same commands. This is the rule
 * that makes cross-product journeys safe and makes the public API possible
 * without a second implementation." An ingress is responsible for
 * authentication, shape validation and reply rendering, and for nothing
 * financial.
 *
 * The gates E1 built are checks a caller could forget. Here they are the
 * order of a function nobody can enter halfway:
 *
 *     entitlement  →  risk tier  →  idempotency  →  the work  →  the answer
 *
 * That order is not arrangeable. Entitlement first because §4.3 rule 1 says a
 * refused request consumes nothing. Risk before idempotency because a command
 * the away assistant may never run must not even take a key. Idempotency
 * before the work because that is what a key is for. The answer last, in the
 * SAME transaction as the work, because a snapshot beside a rolled back sale
 * is a record of something that did not happen.
 *
 * This is the skeleton. It runs commands nobody has written yet, which is
 * deliberate: A1 moves them one at a time behind a flag, and a dispatcher
 * that arrives with fourteen commands already inside it is a refactor nobody
 * can review.
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Ingress, RiskContext, RiskTier } from '@rekoda/core';
import { entitlementsRepo, idempotencyRepo, type TenantDb } from '@rekoda/db';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { COMMAND_ENTITLEMENT, type CommandName } from './command-registry.js';

export interface CommandEnvelope<T> {
  businessId: string;
  command: CommandName;
  payload: T;
  /** The authenticated actor. `system` and `webhook:*` are actors too. */
  actor: string;
  ingress: Ingress;
  /** Which refund, which period, which connection. */
  subject?: string | null;
  context?: RiskContext;
  /** The merchant's confirmation, for a HIGH_RISK command. */
  confirmationId?: string | null;
  /**
   * The caller's retry key. Absent means the caller accepts that a retry may
   * run the command again, which is the honest default for an ingress that
   * has no key of its own to offer.
   */
  idempotencyKey?: string | null;
}

export type CommandOutcome<R> =
  | { readonly outcome: 'done'; readonly result: R; readonly replayed: boolean }
  | { readonly outcome: 'not_entitled'; readonly missing: string; readonly plan: string }
  | { readonly outcome: 'refused'; readonly reason: 'away_assistant_forbidden' }
  | { readonly outcome: 'confirm_first'; readonly tier: RiskTier }
  | { readonly outcome: 'confirmation_expired' }
  | { readonly outcome: 'confirmation_already_used' }
  | { readonly outcome: 'confirmation_invalid' }
  /** The same command with this key is running right now. Do not retry yet. */
  | { readonly outcome: 'in_progress' }
  /** This key already answered a DIFFERENT request. A client bug, named. */
  | { readonly outcome: 'key_reused'; readonly commandName: string };

@Injectable()
export class CommandBus {
  constructor(private readonly risk: RiskPolicyService) {}

  /**
   * Run a command, or say precisely why not.
   *
   * `tx` is the caller's, and the work, the outbox event PR-020 adds and the
   * idempotency snapshot all commit or roll back together. A dispatcher that
   * opened its own transaction would be a dispatcher that could commit an
   * answer to a sale that failed.
   */
  async run<T, R>(
    tx: TenantDb,
    envelope: CommandEnvelope<T>,
    work: () => Promise<R>,
  ): Promise<CommandOutcome<R>> {
    /* 1. ENTITLEMENT. A capability the plan does not hold is refused before
     *    anything is taken, spent or written (spec §4.3 rules 1 and 2). */
    const needs = COMMAND_ENTITLEMENT[envelope.command];
    if (needs) {
      const refusal = await entitlementsRepo.requireEntitlement(tx, envelope.businessId, needs);
      if (refusal) {
        return { outcome: 'not_entitled', missing: refusal.missing, plan: refusal.plan };
      }
    }

    /* 2. RISK TIER. Before the key, so a command the away assistant may never
     *    run does not leave a record suggesting it once tried to. */
    const decision = await this.risk.authorise(tx, {
      businessId: envelope.businessId,
      command: envelope.command,
      subject: envelope.subject ?? null,
      actor: envelope.actor,
      ingress: envelope.ingress,
      ...(envelope.context ? { context: envelope.context } : {}),
      confirmationId: envelope.confirmationId ?? null,
    });
    if (decision.outcome !== 'allowed') return decision;

    /* 3. IDEMPOTENCY, where the caller offered a key. */
    if (!envelope.idempotencyKey) {
      return { outcome: 'done', result: await work(), replayed: false };
    }

    const claim = await idempotencyRepo.claim(tx, {
      businessId: envelope.businessId,
      key: envelope.idempotencyKey,
      commandName: envelope.command,
      requestHash: requestHash(envelope.payload),
    });

    switch (claim.outcome) {
      case 'replay':
        return { outcome: 'done', result: claim.response as R, replayed: true };
      case 'running':
        return { outcome: 'in_progress' };
      case 'key_reused':
        return { outcome: 'key_reused', commandName: claim.commandName };
      case 'fresh': {
        const result = await work();
        await idempotencyRepo.complete(tx, {
          businessId: envelope.businessId,
          id: claim.id,
          response: result ?? null,
        });
        return { outcome: 'done', result, replayed: false };
      }
    }
  }
}

/**
 * A stable fingerprint of the payload.
 *
 * Keys are sorted before hashing, because two JSON objects that differ only
 * in the order a client serialised them are the same request, and telling a
 * merchant their retry was a different command because a field moved would be
 * a refusal nobody could act on.
 */
export function requestHash(payload: unknown): string {
  return createHash('sha256').update(stable(payload)).digest('hex');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}
