import { Logger } from '@nestjs/common';
import type { InvoiceDocument } from '@rekoda/core';
import { identity, issueRepo, type Db } from '@rekoda/db';
import { renderInvoicePdf } from '../documents/pdf.js';
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
 * A separate job from issuing, on purpose. Rendering a PDF and talking to
 * object storage are both slow and both fail for reasons that have nothing to
 * do with the sale — a bucket outage, an expired key — and neither is a reason
 * to refuse a merchant's sale. The invoice is already in the books; this
 * produces the paper.
 *
 * The document is rendered from the SNAPSHOT, not from the live invoice row.
 * That is what makes a re-render years later produce the same document rather
 * than one reflecting every correction since (spec §42).
 */
export function renderDocumentHandler(deps: RenderDocumentDeps): JobHandler {
  const log = new Logger('RenderDocumentJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const invoiceId = typeof payload['invoiceId'] === 'string' ? payload['invoiceId'] : null;
    if (!invoiceId) throw new Error('document.render: payload is missing invoiceId');

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

    await issueRepo.recordDocument(tx, {
      businessId,
      kind: 'invoice_pdf',
      storageKey: stored.key,
      refNumber: invoice.invoiceNumber,
      bytes: stored.bytes,
    });

    log.debug(`rendered ${invoice.invoiceNumber} (${stored.bytes} bytes)`);
  };
}
