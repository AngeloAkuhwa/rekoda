/**
 * M0 exit criterion (engineering plan §11): a seeded business posts a
 * balanced sale via code — end to end through the deterministic core,
 * no database, no framework, no AI.
 *
 *   pnpm demo:m0
 */
import { computeMoney, computeVat, formatKobo } from '../money.js';
import { postExpense, postReceivablePayment, postSale, trialBalance } from '../ledger.js';
import { reconcile, paymentLabel } from '../reconciliation.js';
import { formatDocumentNumber, lagosYear } from '../numbering.js';

console.log('REKODA M0 — deterministic core demo\n');

// ── The merchant speaks (this is what AI will extract; here it is typed) ──
// "Amaka bought 4 bags at ₦28,000 each. She paid ₦80,000."
const draft = computeMoney({
  items: [{ name: 'Bag', quantity: 4, price: 28_000 }],
  amountPaid: 80_000,
});

const invoiceNo = formatDocumentNumber('invoice', lagosYear(new Date()), 1);
console.log(`Sale        ${formatKobo(draft.totalK)}   (${invoiceNo})`);
console.log(`Paid        ${formatKobo(draft.amountPaidK)}`);
console.log(`Outstanding ${formatKobo(draft.balanceDueK)}\n`);

// ── The deterministic core posts it, double-entry ──
const postings = [
  postSale({
    memo: `${invoiceNo} — CUSTOMER_X92, 4 bags`,
    totalK: draft.totalK,
    paidK: draft.amountPaidK,
  }),
  postExpense({ memo: 'Delivery + fuel', amountK: 2_800_000, method: 'cash' }),
  postReceivablePayment({ memo: 'CUSTOMER_X17 cleared old debt', amountK: 2_000_000 }),
];

// ── VAT example (inclusive — the quoted price is never inflated) ──
const vat = computeVat(draft.totalK, 7.5, true);
console.log(
  `If VAT-registered: VAT inside ${formatKobo(draft.totalK)} = ${formatKobo(vat.vatK)}\n`,
);

// ── Trial balance: the ledger must balance or the process exits non-zero ──
const tb = trialBalance(postings);
console.log('TRIAL BALANCE');
for (const row of tb.rows) {
  console.log(`  ${row.account.padEnd(22)} ${formatKobo(row.balanceK).padStart(14)}`);
}
console.log(`  ${'—'.repeat(38)}`);
console.log(`  debits  ${formatKobo(tb.totalDebitsK).padStart(14)}`);
console.log(`  credits ${formatKobo(tb.totalCreditsK).padStart(14)}`);
console.log(`  balanced: ${tb.balanced}\n`);

// ── Paystack later confirms part of the money ──
const verdict = reconcile(
  { kind: 'invoice', ref: invoiceNo, amountDueK: draft.balanceDueK, currency: 'NGN' },
  { ref: 'PSK-88123', amountK: draft.balanceDueK, currency: 'NGN', verified: true },
);
console.log(`Reconciliation of the balance: ${verdict.status}`);
console.log(
  `Label shown to the merchant: ${paymentLabel({ ref: 'PSK-88123', amountK: draft.balanceDueK, currency: 'NGN', verified: true })}`,
);

if (!tb.balanced) {
  console.error('LEDGER DID NOT BALANCE');
  process.exit(1);
}
console.log('\nM0 exit criterion satisfied ✔');
