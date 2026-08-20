import { toKobo, type Kobo } from '@rekoda/core';

/**
 * The commercial model — docs/pricing-model.md is the source of truth.
 * Prices live here as KOBO so nothing downstream ever handles a float,
 * and every figure renders through <Money/> (MASTER.md §7.1).
 *
 * The same honesty rule as the reply layer: `includes` lists only what
 * ships today, and everything sold ahead of itself sits under `coming`,
 * labelled as such on the page. A pricing page that promises an unbuilt
 * feature without saying so is the reply layer's worst bug, with a price
 * attached.
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
  /** On the way, shown under a "Coming soon" label — never mixed into includes. */
  coming?: string[];
  /** Stated plainly rather than discovered later. */
  excludes?: string[];
}

const m = (naira: number): Kobo => toKobo(naira);

export const PLANS: Plan[] = [
  {
    id: 'chat',
    name: 'Rekoda Chat',
    /** §31: WhatsApp is the interface, never the sales-channel restriction. */
    tagline: 'Sell anywhere. Tell Rekoda what happened.',
    monthlyK: m(9_900),
    annualK: m(99_000),
    cta: 'Start with Chat',
    includes: [
      '400 messages processed each month',
      '100 documents',
      'Invoices, receipts and customer balances',
      'Sales, expenses, purchases and stock',
      'Payment links, verified the moment money lands',
      'Full books: profit and loss, balance sheet, cash flow',
      'Dashboard with every register',
    ],
    coming: [
      'Voice-note bookkeeping (60 minutes a month)',
      'Products and inventory',
      'An accountant seat',
    ],
    excludes: ['No online shop'],
  },
  {
    id: 'integrate',
    name: 'Rekoda Integrate',
    tagline: 'Connect your WhatsApp shop. Rekoda handles the money trail.',
    monthlyK: m(19_900),
    annualK: m(199_000),
    highlight: true,
    cta: 'Connect my shop',
    includes: [
      'Everything in Chat, with room to grow',
      '800 messages processed, 500 documents',
      'Payments verified the moment they land',
      'Reconciliation with mismatch detection',
    ],
    coming: [
      'Your own shop link, shared on WhatsApp',
      'Orders captured automatically, nothing retyped',
      'A payment account created for every order',
      'Inventory and customer balances updated for you',
      'Two accountant seats',
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
    includes: ['Everything in Chat and Integrate', '1,200 messages processed, 750 documents'],
    coming: [
      'Online orders and cash sales in one set of books',
      '120 voice minutes, 300 orders',
      'Daily, weekly and monthly summaries',
      'Priority support, plus 3 accountant seats',
    ],
  },
];

export const TRIAL = {
  name: 'Free trial',
  tagline: '30 days. No card needed.',
  includes: [
    '50 messages, enough to see it working',
    '25 documents',
    'Invoices, receipts and the full books',
    'Dashboard with every register',
  ],
};
