/**
 * Regenerates apps/web/public/demo/receipt.png — the landing page's proof
 * that Rekoda produces real documents.
 *
 * It goes through the REAL engine: the same layoutReceipt and renderReceiptPdf
 * that run when a merchant's payment is confirmed, so the marketing image
 * cannot drift from what the product actually sends. The demo data mirrors the
 * hero conversation (3 wigs, ₦150,000, paid in full).
 *
 * Usage (from the repo root, with @rekoda/api built):
 *   pnpm --filter @rekoda/api build
 *   node scripts/render-demo-receipt.mjs
 *   pdftoppm -png -r 220 -singlefile -x 0 -y 0 -W 1282 -H 780 \
 *     /tmp/rekoda-demo-receipt.pdf apps/web/public/demo/receipt
 *
 * The pdftoppm step needs poppler-utils. This is a maintainer tool, run when
 * the receipt layout changes — it is not part of any build.
 */
import { writeFileSync } from 'node:fs';
import { renderReceiptPdf } from '../apps/api/dist/documents/pdf.js';

const OUT = process.argv[2] ?? '/tmp/rekoda-demo-receipt.pdf';

const pdf = await renderReceiptPdf({
  documentNumber: 'RCT-2026-000114',
  issuedAt: new Date('2026-08-14T13:30:00Z'),
  businessName: 'Ada Fashion',
  invoiceNumber: 'INV-2026-000131',
  reference: 'RKD-PAY-20260814-K3Q7XN',
  amountK: 15_000_000,
  allocatedK: 15_000_000,
});

writeFileSync(OUT, pdf);
console.log(`wrote ${OUT} (${pdf.length} bytes)`);
