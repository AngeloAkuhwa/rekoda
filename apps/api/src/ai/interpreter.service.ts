import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  billingPeriod,
  commandValueK,
  costOfCall,
  divergentFields,
  type AiModelRole,
} from '@rekoda/core';
import { PRIVACY_POLICY_VERSION, detectStructuralPii, redactForLog } from '@rekoda/core/privacy';
import {
  businessCommandToolSchema,
  parseBusinessCommand,
  type StructuredBusinessCommand,
} from '@rekoda/contracts';
import { quotaRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import {
  CLASSIFIER_SYSTEM,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_SCHEMA,
  parseDocumentClass,
  type DocumentClass,
} from './classifier.js';
import { SYSTEM_PROMPT, TOOL_DESCRIPTION, TOOL_NAME } from './prompt.js';
import {
  MODEL_TRANSPORT,
  VERIFIER_TRANSPORT,
  ProviderUnreachable,
  type ModelReply,
  type ModelTransport,
} from './transport.js';

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
  | { outcome: 'unavailable'; reason: string }
  /**
   * Two independent readers disagreed on a high-value document (item 9).
   * Neither reading is chosen, no third model is asked, and nothing
   * becomes a draft: the merchant sees which fields conflict and states
   * the figures themselves. `fields` holds canonical paths, never values.
   */
  | { outcome: 'disagreement'; fields: string[] };

/** One reserved, recorded model call — or the reason it did not happen. */
type ModelCall =
  | { kind: 'ok'; reply: ModelReply }
  | { kind: 'refused'; refusedBy: 'business' | 'platform' }
  | { kind: 'unavailable'; reason: string };

/**
 * Why the escalation model was asked. On the cost row, because "what does
 * escalation cost" is only actionable when it can be split by what causes it.
 */
type EscalationReason = 'schema_failure' | 'no_tool_call' | 'unclear';

/**
 * Asking a model what a merchant meant (MASTER-PLAN §5.3.3, ADR 0007).
 *
 * The order is: reserve → call → record → parse. Each step earns its place.
 *
 * **Reserve first**, because a ceiling checked after the call is not a
 * ceiling. **Record before parsing**, because a call that burned tokens and
 * then returned unusable JSON still cost money — a margin view that counts
 * only the successes is a margin view that flatters.
 *
 * ESCALATION (AI hardening item 3) is one bounded retry on the escalation
 * model when the primary's answer cannot safely proceed: it failed the
 * schema, never called the tool, or said Unclear. At most one per message,
 * structurally — the escalation's own answer is never re-escalated. It
 * consumes the same shared quota, its cost is recorded under its own role
 * with the reason on the row, and when it is also uncertain the merchant
 * gets the primary's honest outcome: a question, never a guess.
 */
@Injectable()
export class Interpreter {
  private readonly log = new Logger(Interpreter.name);
  private readonly toolSchema = businessCommandToolSchema();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(MODEL_TRANSPORT) private readonly transport: ModelTransport,
    /** The independent second reader, or null when dual extraction is off. */
    @Optional()
    @Inject(VERIFIER_TRANSPORT)
    private readonly verifier: ModelTransport | null = null,
  ) {}

  /**
   * `safeText` must already be through the privacy gateway. The type system
   * cannot enforce that — a string is a string — so the call site is one of
   * the few places in this codebase where the comment IS the contract, and it
   * is why the gateway runs in the handler rather than here.
   */
  async interpret(
    businessId: string,
    safeText: string,
    opts?: { document?: boolean },
  ): Promise<Interpretation> {
    this.refuseRawPii(safeText);

    const primary = await this.callModel(businessId, {
      model: this.config.aiModelDefault,
      role: 'interpreter',
      system: SYSTEM_PROMPT,
      userText: safeText,
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESCRIPTION,
      toolSchema: this.toolSchema,
      maxTokens: 1_024,
      purpose: 'interpret_message',
    });
    if (primary.kind === 'refused') return { outcome: 'refused', refusedBy: primary.refusedBy };
    if (primary.kind === 'unavailable') return { outcome: 'unavailable', reason: primary.reason };

    const first = this.parseCommandReply(primary.reply);

    const reason = escalationReasonFor(first, primary.reply.stopReason);
    if (!reason) return this.verifyIfHighValue(businessId, safeText, first, opts);

    /**
     * ONE bounded retry, on the model reserved for exactly this. The quota
     * reservation runs again — escalation is a second provider call and a
     * ceiling that waves the expensive tier through is not a ceiling — and
     * a refusal here simply returns the primary's outcome: a merchant at
     * their daily limit gets the honest first answer, not a harder failure.
     */
    const escalationModel = this.config.aiModelEscalation;
    this.log.log(`escalating to ${escalationModel}: ${reason}`);
    const second = await this.callModel(businessId, {
      model: escalationModel,
      role: 'escalation',
      system: SYSTEM_PROMPT,
      userText: safeText,
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESCRIPTION,
      toolSchema: this.toolSchema,
      maxTokens: 1_024,
      purpose: 'interpret_message',
      extraMeta: { escalationReason: reason, escalatedFrom: this.config.aiModelDefault },
    });
    if (second.kind !== 'ok') return first;

    const retried = this.parseCommandReply(second.reply);
    /* The escalation's answer wins only when it IS an answer. Still failing
     * the schema, or still Unclear when the primary was too, falls back to
     * the primary's outcome — uncertainty becomes the merchant's question,
     * never a third call and never a guessed command. */
    const settled = retried.outcome === 'command' ? retried : first;
    return this.verifyIfHighValue(businessId, safeText, settled, opts);
  }

  /**
   * The dual-extraction gate (AI hardening item 9): a document whose money
   * reaches `AI_DUAL_EXTRACT_THRESHOLD_K` is read a second time by an
   * INDEPENDENT provider, and the two readings are compared field by field
   * with no tolerance on amounts. Agreement proceeds to the ordinary
   * confirmation gate; disagreement becomes a review outcome that names
   * the conflicting fields — never a choice between models, never a third
   * model to break the tie.
   *
   * When the verifier is configured but cannot answer — quota refused,
   * provider down, output that fails the schema — the document proceeds
   * UNVERIFIED to the same confirmation gate every write already passes,
   * with a loud log: every financial write remains a draft until the
   * merchant confirms it, so the confirmation gate is the floor and dual
   * extraction is defence in depth above it, not a gate that takes the
   * whole document path down with the second vendor's outage.
   */
  private async verifyIfHighValue(
    businessId: string,
    safeText: string,
    settled: Interpretation,
    opts?: { document?: boolean },
  ): Promise<Interpretation> {
    if (!opts?.document || settled.outcome !== 'command') return settled;
    if (settled.command.intent === 'Unclear' || settled.command.intent === 'Query') {
      return settled;
    }
    const verifierModel = this.config.aiModelVisionVerifier;
    if (!this.verifier || !verifierModel) return settled;
    if (commandValueK(settled.command) < this.config.aiDualExtractThresholdK) return settled;

    const verification = await this.callModel(businessId, {
      model: verifierModel,
      role: 'vision_verifier',
      system: SYSTEM_PROMPT,
      userText: safeText,
      toolName: TOOL_NAME,
      toolDescription: TOOL_DESCRIPTION,
      toolSchema: this.toolSchema,
      maxTokens: 1_024,
      purpose: 'verify_document_extraction',
      transport: this.verifier,
      provider: 'openai',
      extraMeta: { verifies: this.config.aiModelDefault },
    });
    if (verification.kind !== 'ok') {
      this.log.warn('a high-value document proceeds UNVERIFIED: the verifier was unavailable');
      return settled;
    }

    const independent = this.parseCommandReply(verification.reply);
    if (independent.outcome !== 'command') {
      this.log.warn('a high-value document proceeds UNVERIFIED: the verifier failed the schema');
      return settled;
    }

    const fields = divergentFields(settled.command, independent.command);
    if (fields.length === 0) return settled;

    this.log.warn(
      `high-value extraction disagreement on ${fields.length} field(s): ${fields.join(', ')}`,
    );
    return { outcome: 'disagreement', fields };
  }

  /**
   * What kind of page is this text from? (The classifier role, AI hardening
   * item 1 — see classifier.ts for where this may and may not run.)
   *
   * FAIL OPEN: every path that cannot produce a confident class — quota
   * refused, provider down, malformed answer — returns `unsure`, and the
   * caller proceeds to the interpreter as if no classifier existed. The
   * only behaviour this method can change is SKIPPING a more expensive
   * call; it can never block a real document.
   */
  async classifyDocument(businessId: string, safeText: string): Promise<DocumentClass> {
    this.refuseRawPii(safeText);

    const call = await this.callModel(businessId, {
      model: this.config.aiModelClassifier,
      role: 'classifier',
      system: CLASSIFIER_SYSTEM,
      userText: safeText,
      toolName: CLASSIFIER_TOOL_NAME,
      toolDescription: CLASSIFIER_TOOL_DESCRIPTION,
      toolSchema: CLASSIFIER_TOOL_SCHEMA,
      maxTokens: 128,
      purpose: 'classify_document',
    });
    if (call.kind !== 'ok') return 'unsure';
    return parseDocumentClass(call.reply.toolInput);
  }

  /* FAIL CLOSED, before anything is reserved or spent (Appendix C.4): the
   * gateway's contract is that the text is tokenised, and a contract the
   * adapter does not verify is a comment. Structural PII still present
   * means the gateway was bypassed or broken, and the only honest move is
   * an error a human sees — not a quiet redaction that sends the model a
   * sentence nobody wrote. */
  private refuseRawPii(safeText: string): void {
    const rawSpans = detectStructuralPii(safeText);
    if (rawSpans.length > 0) {
      throw new RawProtectedFieldError([...new Set(rawSpans.map((span) => span.kind))]);
    }
  }

  /**
   * Reserve → call → record, for EVERY hosted call whatever its role.
   *
   * One method rather than three copies, because the invariants are the
   * point: no call without a reservation, no reservation kept when the
   * provider was never reached, no reply unrecorded — and a new role added
   * later inherits all three by construction.
   */
  private async callModel(
    businessId: string,
    request: {
      model: string;
      role: AiModelRole;
      system: string;
      userText: string;
      toolName: string;
      toolDescription: string;
      toolSchema: Record<string, unknown>;
      maxTokens: number;
      purpose: string;
      /** The independent verifier passes its own; everyone else the default. */
      transport?: ModelTransport;
      /** Who charges for this call, when it is not the primary provider. */
      provider?: 'anthropic' | 'openai';
      extraMeta?: Record<string, unknown>;
    },
  ): Promise<ModelCall> {
    const reservation = await quotaRepo.reserveAiCall(this.db, businessId, {
      perBusinessPerDay: this.config.aiCallsPerBusinessPerDay,
      globalPerDay: this.config.aiCallsGlobalPerDay,
    });
    if (!reservation.ok) {
      this.log.warn(`${request.role} call refused by the ${reservation.refusedBy} ceiling`);
      return { kind: 'refused', refusedBy: reservation.refusedBy };
    }

    let reply: ModelReply;
    try {
      reply = await (request.transport ?? this.transport).send({
        model: request.model,
        system: request.system,
        userText: request.userText,
        toolName: request.toolName,
        toolDescription: request.toolDescription,
        toolSchema: request.toolSchema,
        maxTokens: request.maxTokens,
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
        await this.recordUnpricedCall(businessId, request, error.message);
        return { kind: 'unavailable', reason: error.message };
      }
      throw error;
    }

    await this.recordUsage(businessId, request, reply);
    return { kind: 'ok', reply };
  }

  /** The tool answer through the strict schema, or the reason it failed. */
  private parseCommandReply(reply: ModelReply): Interpretation {
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
    request: {
      model: string;
      role: AiModelRole;
      purpose: string;
      provider?: 'anthropic' | 'openai';
      extraMeta?: Record<string, unknown>;
    },
    reply: ModelReply,
  ): Promise<void> {
    const cost = costOfCall(request.model, reply.usage, this.config.planningFxNairaPerUsd);
    if (!cost.priced) {
      // Loud, because the alternative is a margin view quietly reporting this
      // model as free until someone reconciles against an invoice.
      this.log.error(`no price for model "${request.model}" — usage recorded at zero cost`);
    }

    await withBusiness(this.db, businessId, (tx: TenantDb) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        // The provider that actually answered. Hard-coding one meant the
        // margin view attributed every OpenAI call to Anthropic; the
        // verifier overrides it because independence includes the invoice.
        provider: request.provider ?? this.config.aiProvider,
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: cost.usdMicros,
        nairaEquivalentK: cost.nairaKobo,
        billingPeriod: billingPeriod(new Date()),
        /* The observability contract (Appendix C.4): processor, model,
         * purpose, tokenisation status and policy version — and NEVER the
         * prompt, the completion or a protected field. `role` is what the
         * margin view groups by once several roles share a provider. */
        meta: {
          role: request.role,
          model: request.model,
          purpose: request.purpose,
          tokenised: true,
          policyVersion: PRIVACY_POLICY_VERSION,
          priced: cost.priced,
          stopReason: reply.stopReason,
          ...reply.usage,
          ...(request.extraMeta ?? {}),
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
    request: { model: string; role: AiModelRole; provider?: 'anthropic' | 'openai' },
    reason: string,
  ): Promise<void> {
    await withBusiness(this.db, businessId, (tx: TenantDb) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: request.provider ?? this.config.aiProvider,
        usageType: 'llm_failed',
        quantity: 1,
        providerCostMicros: 0,
        nairaEquivalentK: 0,
        billingPeriod: billingPeriod(new Date()),
        meta: {
          role: request.role,
          model: request.model,
          priced: false,
          reason: redactForLog(reason),
        },
      }),
    );
  }
}

/**
 * Whether the primary's answer can safely proceed, and if not, why not.
 *
 * `max_tokens` is the one schema failure that must NOT escalate: the output
 * was cut off mid-JSON by the transport's own limit, so the same message on
 * a pricier model hits the same ceiling — that is a configuration fault to
 * fix, not an ambiguity a better reader resolves, and escalating it would
 * pay Opus prices to reproduce it.
 */
function escalationReasonFor(
  first: Interpretation,
  stopReason: string | null,
): EscalationReason | null {
  if (first.outcome === 'unusable') {
    if (stopReason === 'max_tokens') return null;
    return first.reason.includes('without calling the tool') ? 'no_tool_call' : 'schema_failure';
  }
  if (first.outcome === 'command' && first.command.intent === 'Unclear') return 'unclear';
  return null;
}
