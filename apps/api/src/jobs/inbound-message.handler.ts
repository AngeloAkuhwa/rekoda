import { Logger } from '@nestjs/common';
import {
  allowanceFor,
  gateExpense,
  gatePurchase,
  gateSale,
  isSaleSource,
  looksLikeCorrection,
  replies,
  routeMessage,
  usagePeriod,
  type DeterministicIntent,
  type Reply,
} from '@rekoda/core';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import type { StructuredBusinessCommand } from '@rekoda/contracts';
import {
  conversationsRepo,
  events,
  issueRepo,
  jobsRepo,
  spendRepo,
  usageRepo,
  type TenantDb,
} from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { Interpreter } from '../ai/interpreter.service.js';
import type { PrivacyGateway } from '../privacy/gateway.service.js';
import type { ReplySender } from '../replies/reply.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { JobContext, JobHandler } from './runner.js';

export interface InboundMessageDeps {
  gateway: PrivacyGateway;
  interpreter: Interpreter;
  replySender: ReplySender;
  config: ApiConfig;
}

/**
 * What happens to a WhatsApp message after the webhook has answered 200.
 *
 *     open the sealed payload → route → tokenise only if a model is needed
 *       → record → answer
 *
 * Routing happens on the raw text, so a message the deterministic router
 * recognises is understood AND answered without the gateway running at all —
 * no vault write, no match-key lookup, no model call, no naira spent. Both the
 * gateway and the model are paid for only by the messages that need them.
 *
 * Nothing raw is stored on either path, and nothing rehydrated is stored on
 * any path: a reply goes into the conversation tokenised and becomes a real
 * name only inside `ReplySender.send`, for the length of one HTTP request.
 */
export function inboundMessageHandler(deps: InboundMessageDeps): JobHandler {
  const log = new Logger('InboundMessageJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) {
      // Dies rather than retries: a payload with no event id will not grow one.
      throw new Error('inbound.message: payload is missing eventId');
    }

    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      // Attributed to a different tenant, or truncated between enqueue and
      // run. Either way there is nothing here to do and nothing to retry.
      log.warn('inbound.message: no event for this tenant');
      return;
    }

    const body = metaWebhookBody.safeParse(openPayload(event.payload, deps.config.vaultKey));
    if (!body.success) {
      await events.markProcessed(tx, eventId, 'unreadable payload', businessId);
      return;
    }

    const [inbound] = extractInboundEvents(body.data);
    if (!inbound || inbound.kind !== 'message') {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    const text = inbound.text ?? '';
    const route = routeMessage(text);
    const tokenised =
      route.route === 'deterministic' ? null : await deps.gateway.tokenise(businessId, text);

    /**
     * A deterministic message is stored as WHAT IT WAS, not what it said.
     *
     * The router only fires when the whole message is a phrase from a fixed
     * table, so the raw text would be safe to keep — but keeping it would
     * establish a path where raw merchant text reaches a column, and the next
     * person to touch this file would reasonably follow it.
     */
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: route.route === 'deterministic' ? describeIntent(route.intent) : tokenised!.text,
      providerMessageId: inbound.externalId,
    });

    /**
     * `isNew` is what stops a re-run — a reclaimed job, a redelivered webhook
     * — from paying for the same sentence twice AND answering it twice. A
     * merchant receiving one reply per retry is how a bug becomes a nuisance.
     */
    if (!message.isNew) {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    const answer =
      route.route === 'deterministic'
        ? await deterministicReply(tx, businessId, route.intent)
        : await interpretedReply(deps, tx, businessId, text, tokenised!.text, message.id);

    if (answer) {
      await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: answer,
        // Only the model path can produce a reply that names a customer.
        ...(tokenised ? { tokens: tokenised.tokens } : {}),
      });
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.debug(`answered an inbound message routed as ${route.route}`);
  };
}

/**
 * Answers that need no model — and honest placeholders where the capability is
 * not built.
 *
 * `records` and `debtors` are deliberately NOT answered with a summary. There
 * is no ledger to read yet, and a bookkeeping assistant that invents a debtor
 * list has destroyed the only thing it sells.
 */
async function deterministicReply(
  tx: TenantDb,
  businessId: string,
  intent: DeterministicIntent,
): Promise<Reply | null> {
  if (intent.kind === 'affirm') return confirmPendingDraft(tx, businessId);
  if (intent.kind === 'deny' || intent.kind === 'cancel') {
    // A refusal after a preview discards the draft rather than leaving it to
    // be confirmed by an accidental "yes" ten minutes later.
    const dropped = await conversationsRepo.supersedePendingDrafts(tx, businessId);
    return dropped > 0
      ? replies.cancelled()
      : intent.kind === 'cancel'
        ? replies.cancelled()
        : null;
  }

  switch (intent.kind) {
    case 'greeting':
      return replies.greeting();
    case 'help':
      return replies.help();
    case 'stop':
      return replies.optedOut();
    case 'start':
      return replies.optedIn();
    case 'delete_my_data':
      return replies.confirmErasure();
    case 'number':
      return replies.strayNumber();
    case 'debtors':
      return replies.notYet('Your debtor list');
    case 'records':
      return replies.notYet('Sending your records');
    case 'resend':
      return replies.notYet('Resending a document');
    default:
      return null;
  }
}

/**
 * CG3 — a "yes" claims the pending draft, and only one "yes" can.
 *
 * `claimDraft` is a conditional UPDATE whose WHERE clause carries the
 * precondition, so two rapid confirmations become one winner and one loser.
 * The loser is told the truth — the document IS being issued — rather than
 * apologised to for a success.
 */
async function confirmPendingDraft(tx: TenantDb, businessId: string): Promise<Reply | null> {
  const draft = await conversationsRepo.pendingDraft(tx, businessId);
  if (!draft) return replies.nothingToConfirm();
  if (!(await conversationsRepo.claimDraft(tx, draft.id))) return replies.alreadyConfirmed();

  const command = draft.command as { intent?: string } & Record<string, unknown>;
  if (command.intent === 'RecordExpense') return confirmExpense(tx, businessId, draft.id, command);
  if (command.intent === 'RecordPurchase')
    return confirmPurchase(tx, businessId, draft.id, command);
  if (command.intent !== 'RecordSale') {
    // Anything else is not actionable yet. The draft is claimed either way,
    // so an unconfirmable one cannot sit pending forever inviting another yes.
    return replies.notYet('Recording that kind of entry');
  }

  const gate = gateSale(command as never);
  if (gate.gate !== 'CG2') {
    // Should be unreachable: a CG1 draft is never previewed, so nothing ever
    // invited a yes for it. Handled rather than asserted.
    return replies.arithmeticQuestion(gate.question);
  }

  const money = gate.money;
  const issued = await issueRepo.issueSale(tx, {
    businessId,
    customerId: null,
    customerToken: customerTokenOf(command),
    items: (command['items'] as Array<{ name: string; quantity: number; unitPrice: number }>).map(
      (item) => ({
        name: item.name,
        quantity: item.quantity,
        unitPriceK: Math.round(item.unitPrice * 100),
      }),
    ),
    subtotalK: money.subtotalK,
    discountK: money.discountK,
    deliveryFeeK: money.deliveryFeeK,
    vatK: money.vatK,
    totalK: money.totalK,
    paidK: money.amountPaidK,
    balanceDueK: money.balanceDueK,
    method: command['paymentMethod'] === 'cash' ? 'cash' : 'transfer',
    /* Captured-via vs where-it-happened (rekoda-chat-v1 §27): sourceType says
     * this arrived through a Chat conversation; saleSource carries the channel
     * ONLY when the merchant named one, validated against the domain list. */
    sourceType: 'chat',
    sourceId: draft.id,
    saleSource: isSaleSource(command['saleSource']) ? command['saleSource'] : null,
    actor: 'system',
  });

  /**
   * Enqueued INSIDE the same transaction as the sale (MASTER-PLAN §5.3.5 step
   * 9). The invoice and "render its PDF" commit together, so there is no
   * window where a document exists that nothing will ever produce paper for —
   * and a rollback takes the job with it rather than leaving one pointing at
   * an invoice that was never issued.
   *
   * The singleton key is the invoice id: a re-enqueue cannot produce two PDFs
   * with two storage keys for one sale.
   */
  await jobsRepo.enqueue(tx, {
    businessId,
    kind: 'document.render',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: issued.invoiceId,
  });

  return replies.issued(issued.invoiceNumber, money.totalK, money.balanceDueK);
}

/**
 * A confirmed expense: the row and its balanced posting, one transaction, and
 * a reply that says "in your books" rather than pretending a document exists.
 * No render job follows — there is no paper to make.
 */
async function confirmExpense(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: Record<string, unknown>,
): Promise<Reply> {
  const gate = gateExpense(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const description = String(command['description'] ?? '');
  await spendRepo.recordExpense(tx, {
    businessId,
    description,
    category: typeof command['category'] === 'string' ? command['category'] : null,
    amountK: gate.amountK,
    method: command['paymentMethod'] === 'transfer' ? 'transfer' : 'cash',
    sourceType: 'chat',
    sourceId: draftId,
  });
  return replies.expenseSaved(gate.amountK, description);
}

/**
 * A confirmed stock purchase. The supplier MENTION is deliberately dropped at
 * this boundary — names live in the identity vault or nowhere (see spend.ts).
 * What survives is what the books need: the stock, the cost, and what is
 * still owed.
 */
async function confirmPurchase(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: Record<string, unknown>,
): Promise<Reply> {
  const gate = gatePurchase(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const recorded = await spendRepo.recordPurchase(tx, {
    businessId,
    description: String(command['description'] ?? ''),
    amountK: gate.amountK,
    paidK: gate.paidK,
    sourceType: 'chat',
    sourceId: draftId,
  });
  return replies.purchaseSaved(gate.amountK, recorded.owedK);
}

function customerTokenOf(command: Record<string, unknown>): string | null {
  const customer = command['customer'] as { kind?: string; token?: string } | undefined;
  return customer?.kind === 'token' ? (customer.token ?? null) : null;
}

/** The model path: a draft when it worked, an honest sentence when it did not. */
async function interpretedReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  rawText: string,
  safeText: string,
  conversationMessageId: string,
): Promise<Reply> {
  /**
   * The MONTHLY meter (docs/metering-v1.md), checked before the model is
   * paid for. Router-served turns never reach this function, so free
   * commands stay free at zero units. The consume is atomic: two racing
   * messages cannot both take the last unit. Refusal is the doorway reply,
   * and the unit was not spent — a refused message costs the merchant
   * nothing.
   */
  const plan = await usageRepo.planFor(tx, businessId);
  const monthlyMessages = allowanceFor(plan, 'messages');
  const period = usagePeriod(new Date());
  const granted = await usageRepo.consumeUnit(tx, businessId, period, 'messages', monthlyMessages);
  if (!granted) return replies.allowanceExhausted(monthlyMessages);

  const interpreted = await deps.interpreter.interpret(businessId, safeText);

  /**
   * The meter only moves when the product worked. If the model never ran
   * (daily ceiling, provider down) or its answer was unusable, the unit
   * goes back in the same transaction — a merchant must never watch their
   * allowance shrink on Rekoda's failures.
   */
  if (interpreted.outcome !== 'command') {
    await usageRepo.refundUnit(tx, businessId, period, 'messages');
  }

  /**
   * Three failures, three different sentences. Collapsing them into one
   * "something went wrong" would waste the single message a merchant standing
   * in a shop will actually read: "you have hit today's limit" and "I am busy,
   * send it again" call for completely different things from them.
   */
  if (interpreted.outcome === 'refused') {
    return interpreted.refusedBy === 'business'
      ? replies.quotaReachedForBusiness()
      : replies.busyRightNow();
  }
  if (interpreted.outcome === 'unavailable') return replies.busyRightNow();
  if (interpreted.outcome === 'unusable') return replies.couldNotRead();

  /**
   * CG5 — a correction REPLACES the pending draft rather than sitting beside
   * it. Superseded, not deleted: what the merchant first said is part of the
   * record, and it is the only way to answer "why does this say 3 when I said
   * 4". Getting the direction wrong makes a merchant fixing a quantity lose
   * the sale they were fixing.
   */
  const existing = await conversationsRepo.pendingDraft(tx, businessId);
  const correcting = looksLikeCorrection(rawText, existing !== null);
  if (correcting) await conversationsRepo.supersedePendingDrafts(tx, businessId);

  await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId,
    intent: interpreted.command.intent,
    command: interpreted.command,
    model: deps.config.aiModelDefault,
  });

  return acknowledge(interpreted.command, correcting);
}

/**
 * What we say about a command we understood but have not acted on.
 *
 * Saying "Recorded!" here would be the exact failure the gates exist to
 * prevent: claiming something happened before it has. The preview belongs to
 * CG2 and the document to the transaction engine.
 */
function acknowledge(command: StructuredBusinessCommand, correcting: boolean): Reply {
  if (command.intent === 'Unclear') return replies.clarification(command.clarification);

  /**
   * CG1 before CG2, always. A preview of numbers we already know are wrong is
   * a request to approve a mistake. The same order holds for money out: a
   * purchase claiming more paid than it cost gets a question, not a preview.
   */
  const gate =
    command.intent === 'RecordSale'
      ? gateSale(command)
      : command.intent === 'RecordExpense'
        ? gateExpense(command)
        : command.intent === 'RecordPurchase'
          ? gatePurchase(command)
          : null;
  if (!gate) return replies.notYet('Recording that kind of entry');

  if (gate.gate === 'CG1') return replies.arithmeticQuestion(gate.question);
  return replies.preview(
    correcting ? `${replies.correctionTaken().text}\n\n${gate.preview}` : gate.preview,
  );
}

/** The classification, in a form the reply layer can read back. */
function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
