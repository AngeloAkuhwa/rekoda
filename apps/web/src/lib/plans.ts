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
      'Voice-note bookkeeping, 60 minutes a month',
      '100 documents',
      'Invoices, receipts and customer balances',
      'Sales, expenses, purchases and stock',
      'Payment links, verified the moment money lands',
      'Full books: profit and loss, balance sheet, cash flow',
      'Products, inventory and stock counts',
      'One accountant or delegate seat',
      'Dashboard with every register',
    ],
    excludes: ['Automatic order capture needs Integrate'],
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
      'Voice-note bookkeeping, 60 minutes a month',
      'Your own shop link, shared on WhatsApp',
      '300 orders captured automatically, nothing retyped',
      'A payment link for every order, verified when it lands',
      'Inventory and customer balances updated for you',
      'Reconciliation with mismatch detection',
      'Two accountant or delegate seats',
    ],
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
      '1,200 messages processed, 750 documents',
      '120 voice minutes, 300 orders a month',
      'Online orders and cash sales in one set of books',
      'Three accountant or delegate seats',
    ],
    coming: ['Daily, weekly and monthly summaries', 'Priority support'],
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
