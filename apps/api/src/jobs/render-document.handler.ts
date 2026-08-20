import { Logger } from '@nestjs/common';
import type { InvoiceDocument, ReceiptDocument } from '@rekoda/core';
import { identity, issueRepo, jobsRepo, settleRepo, type Db, type TenantDb } from '@rekoda/db';
import { renderInvoicePdf, renderReceiptPdf } from '../documents/pdf.js';
import { documentKey, type DocumentStorage } from '../documents/storage.js';
import type { JobContext, JobHandler } from './runner.js';

export interface RenderDocumentDeps {
  storage: DocumentStorage;
  /** For the business name on the document. Read outside the tenant pin. */
  db: Db;
}

/**
 * Render an issued document and put it somewhere (MASTER-PLAN §5.3.6).
 *
 * A separate job from issuing. Rendering a PDF and talking to
 * object storage are both slow and both fail for reasons that have nothing to
 * do with the sale — a bucket outage, an expired key — and neither is a reason
 * to refuse a merchant's sale. The invoice is already in the books; this
 * produces the paper.
 *
 * One handler, two document kinds: the payload names an `invoiceId` or a
 * `receiptId`, never both. Receipts joined rather than getting their own job
 * kind because everything that makes this job what it is — snapshot-only
 * reads, store-then-record ordering, the deliver hand-off — is identical, and
 * two copies of that reasoning would drift.
 *
 * The document is rendered from the SNAPSHOT, not from the live row. That is
 * what makes a re-render years later produce the same document rather than
 * one reflecting every correction since (spec §42).
 */
export function renderDocumentHandler(deps: RenderDocumentDeps): JobHandler {
  const log = new Logger('RenderDocumentJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const receiptId = typeof payload['receiptId'] === 'string' ? payload['receiptId'] : null;
    if (receiptId) return renderReceipt(deps, log, tx, businessId, receiptId);

    const invoiceId = typeof payload['invoiceId'] === 'string' ? payload['invoiceId'] : null;
    if (!invoiceId) throw new Error('document.render: payload names no invoiceId or receiptId');

    const invoice = await issueRepo.invoiceForRender(tx, businessId, invoiceId);
    if (!invoice) {
      // Another tenant's id, or a truncated fixture. Nothing to retry.
      log.warn('document.render: no invoice for this tenant');
      return;
    }

    const business = await identity.businessById(deps.db, businessId);
    const snapshot = invoice.snapshot as Record<string, unknown>;

    const doc: InvoiceDocument = {
      documentNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt ?? new Date(),
      businessName: business?.name ?? 'Rekoda',
      customerLabel: (snapshot['customerToken'] as string | null) ?? null,
      items: (snapshot['items'] as InvoiceDocument['items']) ?? [],
      subtotalK: Number(snapshot['subtotalK'] ?? 0),
      discountK: Number(snapshot['discountK'] ?? 0),
      deliveryFeeK: Number(snapshot['deliveryFeeK'] ?? 0),
      vatK: Number(snapshot['vatK'] ?? 0),
      totalK: Number(snapshot['totalK'] ?? 0),
      paidK: Number(snapshot['paidK'] ?? 0),
      balanceDueK: Number(snapshot['balanceDueK'] ?? 0),
    };

    const bytes = await renderInvoicePdf(doc);

    /**
     * Stored BEFORE the row is written.
     *
     * The other order gives a row pointing at an object that does not exist —
     * a document a merchant can see listed and can never open, which is worse
     * than one that is not listed at all. This order can leave an orphaned
     * object in the bucket if the insert fails, and an orphan costs a fraction
     * of a naira and nobody's trust.
     */
    const key = documentKey(businessId, 'invoice_pdf');
    const stored = await deps.storage.put(key, bytes, 'application/pdf');

    const record = await issueRepo.recordDocument(tx, {
      businessId,
      kind: 'invoice_pdf',
      storageKey: stored.key,
      refNumber: invoice.invoiceNumber,
      bytes: stored.bytes,
    });

    /**
     * Delivery is a THIRD job, enqueued in this transaction. It fails for
     * reasons that have nothing to do with rendering — Meta unreachable, a
     * token expired — and none of those should re-render a PDF that is already
     * sitting in storage. Keyed on the document id, so a retry of this job
     * cannot queue two deliveries of one file.
     */
    await jobsRepo.enqueue(tx, {
      businessId,
      kind: 'document.deliver',
      payload: { documentId: record.id },
      singletonKey: `deliver:${record.id}`,
    });

    log.debug(`rendered ${invoice.invoiceNumber} (${stored.bytes} bytes)`);
  };
}

/**
 * The receipt path: snapshot → blocks → A5 PDF → storage → document row →
 * deliver job. Field for field the invoice path — see the handler comment.
 */
async function renderReceipt(
  deps: RenderDocumentDeps,
  log: Logger,
  tx: TenantDb,
  businessId: string,
  receiptId: string,
): Promise<void> {
  const receipt = await settleRepo.receiptForRender(tx, businessId, receiptId);
  if (!receipt) {
    log.warn('document.render: no receipt for this tenant');
    return;
  }

  const business = await identity.businessById(deps.db, businessId);
  const snapshot = receipt.snapshot as Record<string, unknown>;

  const doc: ReceiptDocument = {
    documentNumber: receipt.receiptNumber,
    issuedAt: receipt.issuedAt ?? new Date(),
    businessName: business?.name ?? 'Rekoda',
    invoiceNumber: String(snapshot['invoiceNumber'] ?? ''),
    reference: String(snapshot['rekodaReference'] ?? ''),
    amountK: Number(snapshot['amountK'] ?? 0),
    allocatedK: Number(snapshot['allocatedK'] ?? 0),
    /* The snapshot is written with `verified: false` for a payment the
     * merchant reported. Absent means an older verified receipt, from before
     * the merchant path existed. */
    verified: snapshot['verified'] !== false,
  };

  const bytes = await renderReceiptPdf(doc);

  // Stored before recorded, same order and same reasoning as the invoice
  // path: an orphaned object is cheap, a listed-but-unopenable document is not.
  const key = documentKey(businessId, 'receipt_pdf');
  const stored = await deps.storage.put(key, bytes, 'application/pdf');

  const record = await issueRepo.recordDocument(tx, {
    businessId,
    kind: 'receipt_pdf',
    storageKey: stored.key,
    refNumber: receipt.receiptNumber,
    bytes: stored.bytes,
  });

  await jobsRepo.enqueue(tx, {
    businessId,
    kind: 'document.deliver',
    payload: { documentId: record.id },
    singletonKey: `deliver:${record.id}`,
  });

  log.debug(`rendered ${receipt.receiptNumber} (${stored.bytes} bytes)`);
}
