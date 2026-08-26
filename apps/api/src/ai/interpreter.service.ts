import { Inject, Injectable, Logger } from '@nestjs/common';
import { billingPeriod, costOfCall } from '@rekoda/core';
import { PRIVACY_POLICY_VERSION, detectStructuralPii, redactForLog } from '@rekoda/core/privacy';
import {
  businessCommandToolSchema,
  parseBusinessCommand,
  type StructuredBusinessCommand,
} from '@rekoda/contracts';
import { quotaRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { SYSTEM_PROMPT, TOOL_DESCRIPTION, TOOL_NAME } from './prompt.js';
import { MODEL_TRANSPORT, ProviderUnreachable, type ModelTransport } from './transport.js';

/**
 * A raw protected field reached the adapter (spec Appendix C.4).
 *
 * Thrown, never silently redacted: a silently redacted prompt returns a
 * confidently wrong answer about a sentence the model never actually read,
 * and the merchant acts on it. The error names the KINDS found and never
 * the values, because this message goes to logs.
 */
export class RawProtectedFieldError extends Error {
  override readonly name = 'RawProtectedFieldError';
  constructor(readonly kinds: readonly string[]) {
    super(`refusing to send: raw ${kinds.join(', ')} in text bound for the model`);
  }
}

export type Interpretation =
  | { outcome: 'command'; command: StructuredBusinessCommand }
  /** The model answered, and what it produced did not survive the schema. */
  | { outcome: 'unusable'; reason: string }
  /** A ceiling refused before anything was spent. */
  | { outcome: 'refused'; refusedBy: 'business' | 'platform' }
  /** The provider could not be reached. Nothing was billed; the slot is back. */
  | { outcome: 'unavailable'; reason: string };

/**
 * Asking a model what a merchant meant (MASTER-PLAN §5.3.3, ADR 0007).
 *
 * The order is: reserve → call → record → parse. Each step earns its place.
 *
 * **Reserve first**, because a ceiling checked after the call is not a
 * ceiling. **Record before parsing**, because a call that burned tokens and
 * then returned unusable JSON still cost money — a margin view that counts
 * only the successes is a margin view that flatters.
 */
@Injectable()
export class Interpreter {
  private readonly log = new Logger(Interpreter.name);
  private readonly toolSchema = businessCommandToolSchema();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(MODEL_TRANSPORT) private readonly transport: ModelTransport,
  ) {}

  /**
   * `safeText` must already be through the privacy gateway. The type system
   * cannot enforce that — a string is a string — so the call site is one of
   * the few places in this codebase where the comment IS the contract, and it
   * is why the gateway runs in the handler rather than here.
   */
  async interpret(businessId: string, safeText: string): Promise<Interpretation> {
    /* FAIL CLOSED, before anything is reserved or spent (Appendix C.4): the
     * gateway's contract is that `safeText` is tokenised, and a contract the
     * adapter does not verify is a comment. Structural PII still present
     * means the gateway was bypassed or broken, and the only honest move is
     * an error a human sees — not a quiet redaction that sends the model a
     * sentence nobody wrote. */
    const rawSpans = detectStructuralPii(safeText);
    if (rawSpans.length > 0) {
      throw new RawProtectedFieldError([...new Set(rawSpans.map((span) => span.kind))]);
    }

    const reservation = await quotaRepo.reserveAiCall(this.db, businessId, {
      perBusinessPerDay: this.config.aiCallsPerBusinessPerDay,
      globalPerDay: this.config.aiCallsGlobalPerDay,
    });
    if (!reservation.ok) {
      this.log.warn(`AI call refused by the ${reservation.refusedBy} ceiling`);
      return { outcome: 'refused', refusedBy: reservation.refusedBy };
    }

    const model = this.config.aiModelDefault;
    let reply;
    try {
      reply = await this.transport.send({
        model,
        system: SYSTEM_PROMPT,
        userText: safeText,
        toolName: TOOL_NAME,
        toolDescription: TOOL_DESCRIPTION,
        toolSchema: this.toolSchema,
        maxTokens: 1_024,
      });
    } catch (error) {
      if (error instanceof ProviderUnreachable) {
        // The merchant keeps the slot: being unable to reach a provider must
        // not spend their daily allowance.
        await quotaRepo.releaseAiCall(this.db, businessId);
        /* But WE may still have been billed. A request that timed out after
         * the provider began generating is charged, and recording it as
         * nothing would put a real cost outside the margin view entirely.
         * Zero tokens with `priced: false` says "this happened and we cannot
         * price it", which is a row somebody can reconcile. */
        await this.recordUnpricedCall(businessId, model, 'llm_failed', error.message);
        return { outcome: 'unavailable', reason: error.message };
      }
      throw error;
    }

    await this.recordUsage(businessId, model, reply.usage, reply.stopReason);

    if (reply.toolInput === null) {
      // Forced tool use should make this impossible. "Should" is why it is
      // handled rather than asserted.
      return { outcome: 'unusable', reason: 'the model answered without calling the tool' };
    }

    const raw = (reply.toolInput as { command?: unknown }).command;
    const parsed = parseBusinessCommand(raw);
    if (!parsed.ok) {
      this.log.warn(`model output failed the schema: ${redactForLog(parsed.error)}`);
      return { outcome: 'unusable', reason: parsed.error };
    }
    return { outcome: 'command', command: parsed.command };
  }

  /**
   * One `usage_events` row per call, whatever became of it.
   *
   * `stopReason` is worth keeping: `max_tokens` means the model was cut off
   * mid-JSON, which looks identical to a schema failure from the outside and
   * has a completely different fix.
   */
  private async recordUsage(
    businessId: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number },
    stopReason: string | null,
  ): Promise<void> {
    const cost = costOfCall(model, usage, this.config.planningFxNairaPerUsd);
    if (!cost.priced) {
      // Loud, because the alternative is a margin view quietly reporting this
      // model as free until someone reconciles against an invoice.
      this.log.error(`no price for model "${model}" — usage recorded at zero cost`);
    }

    await withBusiness(this.db, businessId, (tx: TenantDb) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        // The provider that actually answered. Hard-coding one meant the
        // margin view attributed every OpenAI call to Anthropic.
        provider: this.config.aiProvider,
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: cost.usdMicros,
        nairaEquivalentK: cost.nairaKobo,
        billingPeriod: billingPeriod(new Date()),
        /* The observability contract (Appendix C.4): processor, model,
         * purpose, tokenisation status and policy version — and NEVER the
         * prompt, the completion or a protected field. */
        meta: {
          model,
          purpose: 'interpret_message',
          tokenised: true,
          policyVersion: PRIVACY_POLICY_VERSION,
          priced: cost.priced,
          stopReason,
          ...usage,
        },
      }),
    );
  }

  /**
   * A call that happened and cannot be costed: a timeout, a dropped socket.
   *
   * Deliberately separate from `recordUsage` — it has no token counts to
   * price, and inventing an estimate would be the wrong kind of certainty.
   * The row exists so the count of calls in the margin view matches the count
   * on the invoice; the money on it is the provider's to tell us.
   */
  private async recordUnpricedCall(
    businessId: string,
    model: string,
    usageType: string,
    reason: string,
  ): Promise<void> {
    await withBusiness(this.db, businessId, (tx: TenantDb) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: this.config.aiProvider,
        usageType,
        quantity: 1,
        providerCostMicros: 0,
        nairaEquivalentK: 0,
        billingPeriod: billingPeriod(new Date()),
        meta: { model, priced: false, reason: redactForLog(reason) },
      }),
    );
  }
}
