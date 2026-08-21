/**
 * The dashboard's section navigation. Plain anchors, server-rendered:
 * these are page loads, not client-side route state.
 */
const TABS = [
  { key: 'overview', href: '/app', label: 'Overview' },
  { key: 'invoices', href: '/app/invoices', label: 'Invoices' },
  { key: 'receipts', href: '/app/receipts', label: 'Receipts' },
  { key: 'expenses', href: '/app/expenses', label: 'Expenses' },
  { key: 'stock', href: '/app/stock', label: 'Stock' },
  { key: 'reports', href: '/app/reports', label: 'Reports' },
  { key: 'audit', href: '/app/audit', label: 'Audit' },
  { key: 'payments', href: '/app/payments', label: 'Payments' },
  { key: 'team', href: '/app/team', label: 'Team' },
  { key: 'billing', href: '/app/billing', label: 'Billing' },
] as const;

export type AppTab = (typeof TABS)[number]['key'];

export function AppNav({ active }: { active: AppTab }) {
  return (
    <nav className="rk-appnav" aria-label="Dashboard sections">
      {TABS.map((tab) => (
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
