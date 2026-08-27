-- Seed the chart of accounts for every business that already exists
-- (spec §11; PR-030).
--
-- The same chart `seedChartOfAccounts` gives a NEW business at creation:
-- the seventeen legacy ledger keys on their existing codes — a re-rendered
-- statement must not renumber a month already reported — plus the §11.2
-- roles the engine will rely on that had no legacy key. The integration
-- suite executes this file against a bare business and proves it produces
-- row for row what the TypeScript seed produces, so the two cannot drift.
--
-- Idempotent by WHERE NOT EXISTS on the natural keys, because a data
-- migration that cannot be re-run against a partially seeded estate is a
-- data migration nobody dares run.
--
-- The two PAYMENT_CONNECTION roles are deliberately absent: clearing
-- accounts are provisioned per connection (PR-053).

/* ── the places money sits ─────────────────────────────────────────────── */
INSERT INTO financial_accounts (business_id, kind, label)
SELECT b.id, f.kind, f.label
FROM businesses b
CROSS JOIN (VALUES
  ('till', 'Cash on hand'),
  ('provider_settlement', 'Paystack settlements'),
  ('bank', 'Bank')
) AS f(kind, label)
WHERE NOT EXISTS (
  SELECT 1 FROM financial_accounts fa
  WHERE fa.business_id = b.id AND fa.kind = f.kind AND fa.label = f.label
);

/* ── business-scoped roles and the roleless legacy accounts ───────────── */
INSERT INTO accounts
  (business_id, code, name, type, contra, system_role, system_scope_type, scope_business_id)
SELECT b.id, a.code, a.name, a.type, a.contra,
       a.role,
       CASE WHEN a.role IS NULL THEN NULL ELSE 'BUSINESS' END,
       CASE WHEN a.role IS NULL THEN NULL ELSE b.id END
FROM businesses b
CROSS JOIN (VALUES
  ('1100', 'Accounts Receivable',              'asset',     false, 'ACCOUNTS_RECEIVABLE'),
  ('1150', 'Input VAT recoverable',            'asset',     false, 'INPUT_VAT_RECOVERABLE'),
  ('1160', 'Withholding tax receivable',       'asset',     false, 'WITHHOLDING_RECEIVABLE'),
  ('1200', 'Inventory',                        'asset',     false, 'INVENTORY_ASSET'),
  ('1300', 'Equipment',                        'asset',     false, NULL),
  ('1310', 'Less: accumulated depreciation',   'asset',     true,  NULL),
  ('2000', 'Accounts Payable',                 'liability', false, 'ACCOUNTS_PAYABLE'),
  ('2100', 'VAT Payable',                      'liability', false, 'VAT_PAYABLE'),
  ('2200', 'Unearned revenue',                 'liability', false, 'CONTRACT_LIABILITY'),
  ('2300', 'Customer credits',                 'liability', false, 'CUSTOMER_CREDIT'),
  ('3000', 'Owner''s Equity',                  'equity',    false, 'OWNER_EQUITY'),
  ('3100', 'Retained earnings',                'equity',    false, 'RETAINED_EARNINGS'),
  ('3900', 'Opening balance equity',           'equity',    false, 'OPENING_BALANCE_EQUITY'),
  ('4000', 'Sales Revenue',                    'income',    false, 'SALES_REVENUE'),
  ('4100', 'Sales returns',                    'income',    true,  'SALES_RETURNS'),
  ('5000', 'Cost of Goods Sold',               'expense',   false, 'COGS'),
  ('6000', 'Operating Expenses',               'expense',   false, 'OPERATING_EXPENSES'),
  ('6050', 'Payment processing fees',          'expense',   false, 'PAYMENT_PROCESSING_FEES'),
  ('6100', 'Depreciation',                     'expense',   false, 'DEPRECIATION'),
  ('6200', 'Loss (or gain) on equipment sold', 'expense',   false, NULL)
) AS a(code, name, type, contra, role)
WHERE NOT EXISTS (
  SELECT 1 FROM accounts x WHERE x.business_id = b.id AND x.code = a.code
);

/* ── the money accounts, scoped to where the money sits ───────────────── */
INSERT INTO accounts
  (business_id, code, name, type, contra, system_role, system_scope_type,
   scope_financial_account_id)
SELECT b.id, a.code, a.name, 'asset', false, a.role, 'FINANCIAL_ACCOUNT', fa.id
FROM businesses b
CROSS JOIN (VALUES
  ('1000', 'Cash on Hand',                'CASH', 'till',                'Cash on hand'),
  ('1010', 'Bank (Paystack settlements)', 'BANK', 'provider_settlement', 'Paystack settlements'),
  ('1020', 'Bank',                        'BANK', 'bank',                'Bank')
) AS a(code, name, role, fa_kind, fa_label)
JOIN financial_accounts fa
  ON fa.business_id = b.id AND fa.kind = a.fa_kind AND fa.label = a.fa_label
WHERE NOT EXISTS (
  SELECT 1 FROM accounts x WHERE x.business_id = b.id AND x.code = a.code
);
