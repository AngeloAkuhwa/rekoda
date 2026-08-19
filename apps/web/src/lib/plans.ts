import { toKobo, type Kobo } from '@rekoda/core';

/**
 * The commercial model — docs/pricing-model.md is the source of truth.
 * Prices live here as KOBO so nothing downstream ever handles a float,
 * and every figure renders through <Money/> (MASTER.md §7.1).
 */
export interface Plan {
  id: 'trial' | 'chat' | 'integrate' | 'complete';
  name: string;
  tagline: string;
  monthlyK: Kobo;
  /** Annual = 10× monthly — roughly two months free. */
  annualK: Kobo;
  highlight?: boolean;
  cta: string;
  includes: string[];
  /** Stated plainly rather than discovered later. */
  excludes?: string[];
}

const m = (naira: number): Kobo => toKobo(naira);

export const PLANS: Plan[] = [
  {
    id: 'chat',
    name: 'Rekoda Chat',
    tagline: 'Talk to Rekoda. Your records build themselves.',
    monthlyK: m(9_900),
    annualK: m(99_000),
    cta: 'Start with Chat',
    includes: [
      '400 messages processed each month',
      '60 minutes of voice notes',
      '100 documents',
      'Invoices, receipts and customer balances',
      'Sales, expenses, purchases and suppliers',
      'Products and inventory',
      'Full books: profit and loss, balance sheet, cash flow',
      'Dashboard, plus 1 accountant',
    ],
    excludes: ['No online shop', 'Payments are recorded, not automatically verified'],
  },
  {
    id: 'integrate',
    name: 'Rekoda Integrate',
    tagline: 'Your shop takes the order. Rekoda handles the money trail.',
    monthlyK: m(19_900),
    annualK: m(199_000),
    highlight: true,
    cta: 'Connect my shop',
    includes: [
      'Your own shop link, shared on WhatsApp',
      'Orders captured automatically, nothing retyped',
      'A payment account created for every order',
      'Payments verified the moment they land',
      'Automatic invoices and receipts',
      'Inventory and customer balances updated for you',
      'Reconciliation with mismatch detection',
      '800 messages processed, 500 documents',
      'Dashboard, plus 2 accountants',
    ],
    excludes: ['No voice-note bookkeeping for cash sales'],
  },
  {
    id: 'complete',
    name: 'Rekoda Complete',
    tagline: 'However you sell, Rekoda keeps everything together.',
    monthlyK: m(29_900),
    annualK: m(299_000),
    cta: 'Run my business on Rekoda',
    includes: [
      'Everything in Chat and Integrate',
      'Online orders and cash sales in one set of books',
      '1,200 messages processed, 120 voice minutes',
      '750 documents, 300 orders',
      'Daily, weekly and monthly summaries',
      'Priority support, plus 3 accountants',
    ],
  },
];

export const TRIAL = {
  name: 'Free trial',
  tagline: '30 days. No card needed.',
  includes: [
    '25 documents, enough to see it working',
    '50 messages, 10 voice minutes',
    '25 recorded transactions',
    'Dashboard, customers and products',
    'Connect your shop during the trial if you want to',
  ],
};
