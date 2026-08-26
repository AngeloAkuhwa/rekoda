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

/**
 * Every plan enum, in the words a merchant reads. Shared so no page prints
 * the database's own word: an eyebrow reading `integrate` and a bill reading
 * `Rekoda Integrate` were describing the same subscription.
 */
export const PLAN_NAMES: Record<string, string> = {
  trial: 'Free trial',
  expired: 'Stopped',
  chat: 'Rekoda Chat',
  integrate: 'Rekoda Integrate',
  complete: 'Rekoda Complete',
};

export const PLANS: Plan[] = [
  {
    id: 'chat',
    name: 'Rekoda Chat',
    /** §31: WhatsApp is the interface, never the sales-channel restriction. */
    tagline: 'Run your business by talking to Rekoda.',
    monthlyK: m(9_900),
    annualK: m(99_000),
    cta: 'Start with Chat',
    includes: [
      '400 messages processed each month',
      'Voice-note bookkeeping, 60 minutes a month',
      '100 documents',
      'Invoices, receipts and customer balances',
      'Sales, expenses, purchases and stock',
      'Full books: profit and loss, balance sheet, cash flow',
      'Products, inventory and stock counts',
      'One accountant or delegate seat',
      'Dashboard with every register',
    ],
    coming: ['Payment links, verified the moment money lands'],
    excludes: ['Automatic order capture needs Integrate'],
  },
  {
    id: 'integrate',
    name: 'Rekoda Integrate',
    tagline: 'Connect your customer commerce to Rekoda.',
    monthlyK: m(19_900),
    annualK: m(199_000),
    highlight: true,
    cta: 'Connect my shop',
    includes: [
      'Your own shop link, shared on WhatsApp',
      '300 orders captured automatically, nothing retyped',
      '500 invoices and receipts a month',
      'Inventory and customer balances updated for you',
      'Reconciliation with mismatch detection',
      'Two accountant or delegate seats',
      'The full dashboard, and your books to keep by hand',
    ],
    coming: ['A payment link for every order, verified when it lands'],
    /* Named rather than discovered on the day they send a voice note. The
     * server refuses these for an Integrate plan, so the page must not sell
     * them: that gap between copy and gate is what this list closes. */
    excludes: ['Talking to Rekoda by message, voice or document needs Chat'],
  },
  {
    id: 'complete',
    name: 'Rekoda Complete',
    tagline: 'Both ways of working, one set of books.',
    monthlyK: m(29_900),
    annualK: m(299_000),
    cta: 'Run my business on Rekoda',
    includes: [
      'Rekoda Chat and Rekoda Integrate together',
      '1,200 messages processed, 750 documents',
      '120 voice minutes, 300 orders a month',
      'Online orders and cash sales in one set of books',
      'Three accountant or delegate seats',
    ],
    coming: ['Daily, weekly and monthly summaries', 'Priority support'],
  },
];

/**
 * What every paid plan carries, said once rather than repeated three times.
 *
 * The dashboard is a SHARED merchant control plane (owner decision, 26 Aug
 * 2026): it is not owned by Chat and it is not a fourth product. Saying so on
 * the page matters, because the alternative reading — that an Integrate
 * merchant cannot record their own electricity bill without buying a second
 * product — is the one a reader assumes when nothing says otherwise.
 */
export const SHARED_ACROSS_PLANS = [
  'The business dashboard: your records, customers, suppliers and stock',
  'Invoices, receipts, customer and supplier balances',
  'Full books: profit and loss, balance sheet, cash flow',
  'Recording sales, expenses, purchases and stock by hand',
  'Payment and bank connections, and reconciliation',
] as const;

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
