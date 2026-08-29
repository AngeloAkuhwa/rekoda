import type { Capability } from '@rekoda/core';
import { canReadAudit } from '@/lib/permissions';

/**
 * The dashboard's section navigation. Plain anchors, server-rendered:
 * these are page loads, not client-side route state.
 *
 * A tab is hidden when the merchant's plan does not carry the capability
 * behind it. Hidden, not greyed: the operational surface is where somebody
 * works, and a permanent row of things they cannot use is an advertisement
 * they did not ask for. The full matrix lives on the billing page, and
 * anybody who arrives at the page itself gets `EntitlementRefusal`.
 *
 * The gate is a CAPABILITY and never a plan name. `plan === 'integrate'` in a
 * navigation component is the shape that rots: it names a product, in a
 * layout, about a route.
 */
const TABS = [
  { key: 'overview', href: '/app', label: 'Overview' },
  { key: 'invoices', href: '/app/invoices', label: 'Invoices' },
  { key: 'receipts', href: '/app/receipts', label: 'Receipts' },
  /* Beside the money-in pages: who still owes is the question a merchant
     asks right after "what came in". */
  { key: 'debtors', href: '/app/debtors', label: 'Debtors' },
  { key: 'expenses', href: '/app/expenses', label: 'Expenses' },
  { key: 'stock', href: '/app/stock', label: 'Stock' },
  /* The catalogue a merchant's BUYERS browse, so it belongs to Integrate.
     Everything around it in this list is the shared control plane. */
  { key: 'catalogue', href: '/app/catalogue', label: 'Catalogue', needs: 'CATALOGUE' },
  { key: 'reports', href: '/app/reports', label: 'Reports' },
  /* Beside Reports rather than last. Both answer "is this true", and a tab
     added to the end of twelve is one a merchant scrolls past without ever
     seeing it sit under their own cursor. */
  { key: 'bank', href: '/app/bank', label: 'Bank' },
  { key: 'audit', href: '/app/audit', label: 'Audit' },
  { key: 'payments', href: '/app/payments', label: 'Payments' },
  { key: 'team', href: '/app/team', label: 'Team' },
  { key: 'billing', href: '/app/billing', label: 'Billing' },
  /* Last on purpose: settings is where a merchant goes ON PURPOSE, not a
     place they work in, and everything they reach for daily stays where
     their thumb already knows it is. */
  { key: 'settings', href: '/app/settings', label: 'Settings' },
] as const;

export type AppTab = (typeof TABS)[number]['key'];

export function AppNav({
  active,
  held,
  role,
}: {
  active: AppTab;
  held?: readonly Capability[];
  role?: string;
}) {
  /* Undefined rather than empty when a caller has not resolved capabilities
     yet: hiding every gated tab because a page forgot to pass them would be
     a worse failure than showing one too many. `role` follows the same rule
     for the same reason. */
  const visible = TABS.filter((tab) => {
    if ('needs' in tab && held !== undefined && !held.includes(tab.needs as Capability)) {
      return false;
    }
    /* The one tab gated by ROLE rather than by plan: the audit trail is the
       owner's and the accountant's (permissions.canReadAudit). A delegate
       who sees the tab is being offered a page the API will refuse. */
    if (tab.key === 'audit' && role !== undefined && !canReadAudit(role)) return false;
    return true;
  });
  return (
    <nav className="rk-appnav" aria-label="Dashboard sections">
      {visible.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? 'page' : undefined}
          className={tab.key === active ? 'rk-appnav-active' : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
