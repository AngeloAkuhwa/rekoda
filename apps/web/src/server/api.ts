import 'server-only';
import {
  type CancelPurchaseOrderResponse,
  type CancelQuoteResponse,
  type ConvertQuoteResponse,
  type CreatePurchaseOrderRequest,
  type CreatePurchaseOrderResponse,
  type CreateQuoteResponse,
  type CreateQuoteRequest,
  type ReceivePurchaseOrderResponse,
  cancelPurchaseOrderResponse,
  cancelQuoteResponse,
  convertQuoteResponse,
  createPurchaseOrderResponse,
  createQuoteResponse,
  receivePurchaseOrderResponse,
  meResponse,
  paymentConnectionResponse,
  paymentExceptionsResponse,
  paymentsListResponse,
  magicRedeemResponse,
  reportsActivityResponse,
  reportsAuditResponse,
  reportsCashflowResponse,
  reportsDebtorsResponse,
  reportsExpensesResponse,
  paySupplierResponse,
  disposeAssetResponse,
  recordAssetResponse,
  recordPaymentResponse,
  withdrawAssetResponse,
  reportsInvoicesResponse,
  teamResponse,
  reportsOverviewResponse,
  reportsReceiptsResponse,
  reportsStatementsResponse,
  reportsStockResponse,
  requestOtpResponse,
  sessionResponse,
  setupStateResponse,
  billingCancelResponse,
  billingOverviewResponse,
  businessSettingsResponse,
  businessSettingsView,
  billingPlanChangeResponse,
  billingQuoteResponse,
  usageMeterResponse,
  catalogueResponse,
  createRecurringResponse,
  openingBalancesResponse,
  stockCountResponse,
  closeBooksResponse,
  journalEntryResponse,
  bankFeedStateResponse,
  bankPositionResponse,
  connectBankFeedResponse,
  syncBankFeedResponse,
  importStatementResponse,
  forgetStatementDayResponse,
  reconcileResponse,
  matchLineResponse,
  unmatchLineResponse,
  reopenBooksResponse,
  publicShopIndexResponse,
  publicShopResponse,
  saveShopResponse,
  shopSettingsResponse,
  creditInvoiceResponse,
  editProductResponse,
  uploadImageResponse,
  stopRecurringResponse,
  voidExpenseResponse,
  voidInvoiceResponse,
  verifyOtpResponse,
  type BillingCancelResponse,
  type BillingOverviewResponse,
  type BusinessSettingsRequest,
  type BusinessSettingsResponse,
  type BusinessSettingsView,
  type BillingPlanChangeResponse,
  type BillingQuoteResponse,
  type MeResponse,
  type CatalogueResponse,
  type CreateRecurringRequest,
  type OpeningBalancesRequest,
  type StockCountRequest,
  type StockCountResponse,
  type CloseBooksRequest,
  type JournalEntryRequest,
  type JournalEntryResponse,
  type BankFeedStateResponse,
  type BankPositionResponse,
  type ConnectBankFeedResponse,
  type SyncBankFeedResponse,
  type ImportStatementResponse,
  type ForgetStatementDayResponse,
  type ReconcileResponse,
  type MatchLineRequest,
  type MatchLineResponse,
  type UnmatchLineResponse,
  type CloseBooksResponse,
  type ReopenBooksRequest,
  type ReopenBooksResponse,
  type OpeningBalancesResponse,
  type PublicShopIndexResponse,
  type PublicShopResponse,
  type SaveShopRequest,
  type SaveShopResponse,
  type ShopSettingsResponse,
  type CreateRecurringResponse,
  type EditProductRequest,
  type EditProductResponse,
  type UploadImageResponse,
  type CreditInvoiceResponse,
  type StopRecurringResponse,
  type VoidExpenseResponse,
  type VoidInvoiceResponse,
  type PaymentConnectionResponse,
  type PaymentExceptionsResponse,
  type PaymentsListResponse,
  type MagicRedeemResponse,
  type ReportsActivityResponse,
  type ReportsAuditResponse,
  type ReportsCashflowResponse,
  type ReportsStockResponse,
  type ReportsDebtorsResponse,
  type ReportsExpensesResponse,
  type PaySupplierResponse,
  type DisposeAssetResponse,
  type RecordAssetRequest,
  type RecordAssetResponse,
  type RecordPaymentResponse,
  type WithdrawAssetResponse,
  type ReportsInvoicesResponse,
  type TeamResponse,
  type ReportsOverviewResponse,
  type ReportsReceiptsResponse,
  type ReportsStatementsResponse,
  type SubmitConnectionRequest,
  type RequestOtpResponse,
  type SessionResponse,
  type SetupStateResponse,
  type UsageMeterResponse,
  type VerifyOtpResponse,
} from '@rekoda/contracts';

/**
 * The web tier's only route to identity.
 *
 * Every response is parsed against the shared zod contract rather than cast, so
 * a field the API renames surfaces here as a thrown error at the boundary
 * instead of `undefined` three components deep in front of a merchant.
 *
 * Nothing in this file holds a database handle or a signing secret. The web
 * tier cannot mint a session, cannot validate one, and cannot read another
 * tenant's rows even by mistake — it can only carry opaque tokens the API
 * issued.
 */
const BASE = process.env.REKODA_API_URL ?? 'http://127.0.0.1:3001';

export class ApiUnauthorised extends Error {}
export class ApiUnavailable extends Error {}
/**
 * The API answered something no caller anticipated.
 *
 * This exists because its absence hid a real bug: a bodyless DELETE was being
 * sent with `content-type: application/json`, Fastify rejected it with 400, and
 * `call()` returned that 400 to a caller that only looked for 401. Sign-out
 * therefore cleared the cookie and left the session live server-side — a logout
 * that logged nobody out, reported as success. Unexpected statuses are now
 * loud.
 */
/**
 * A 403 is a fact about the CALLER, not the request: the session is fine and
 * the body was never read, the role just does not open this door. Form
 * actions turn it into a sentence instead of a crashed page, so a view-only
 * member who finds a button sees policy rather than an error screen.
 */
export class ApiForbidden extends Error {
  constructor(path: string) {
    super(`forbidden: ${path}`);
  }
}

/** The uniform refusal for a role that cannot do this. Rethrows anything else. */
export function viewOnlyRefusal(error: unknown): { error: string } {
  if (error instanceof ApiForbidden) {
    return {
      error:
        'Your access to this business is view only, so this action is not available. ' +
        'Ask the owner if it should be.',
    };
  }
  throw error;
}

export class ApiUnexpectedStatus extends Error {
  constructor(path: string, status: number) {
    super(`unexpected ${status} from ${path}`);
  }
}

interface CallOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Statuses this caller handles. Anything else throws rather than returning. */
  expect: number[];
}

async function call(options: CallOptions): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${options.path}`, {
      method: options.method,
      headers: {
        // Only when there is actually a body. Fastify rejects a bodyless
        // request that claims to carry JSON, which is how sign-out broke.
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      // Spread rather than `body: undefined` — under exactOptionalPropertyTypes
      // an explicit undefined is not the same as an absent property.
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      // Identity is never served from a cache, at any layer.
      cache: 'no-store',
    });
  } catch (cause) {
    // A dead API must read as "we are down", not as a merchant mistake.
    throw new ApiUnavailable(`cannot reach the Rekoda API at ${BASE}`, { cause });
  }

  if (!options.expect.includes(response.status)) {
    if (response.status === 403) throw new ApiForbidden(options.path);
    throw new ApiUnexpectedStatus(options.path, response.status);
  }
  if (response.status === 204) return { status: 204, json: null };
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
}

export async function requestOtp(phone: string): Promise<RequestOtpResponse | 'invalid_phone'> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/auth/otp/request',
    body: { phone },
    expect: [200, 400],
  });
  if (status === 400) return 'invalid_phone';
  return requestOtpResponse.parse(json);
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<VerifyOtpResponse | 'invalid_phone'> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/auth/otp/verify',
    body: { phone, code },
    expect: [200, 400],
  });
  if (status === 400) return 'invalid_phone';
  return verifyOtpResponse.parse(json);
}

/** Null rather than throwing: an absent or forged grant is a redirect, not a crash. */
export async function readSetupState(setupToken: string): Promise<SetupStateResponse | null> {
  const { status, json } = await call({
    method: 'GET',
    path: '/v1/auth/setup',
    headers: { 'x-rekoda-setup-token': setupToken },
    expect: [200, 401],
  });
  if (status === 401) return null;
  return setupStateResponse.parse(json);
}

export async function createBusiness(
  setupToken: string,
  input: { name: string; businessType: string | null },
): Promise<SessionResponse> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/businesses',
    body: input,
    headers: { 'x-rekoda-setup-token': setupToken },
    expect: [201, 401],
  });
  if (status === 401) throw new ApiUnauthorised('setup grant is missing, expired or forged');
  return sessionResponse.parse(json);
}

/** Null rather than throwing — an expired session is an ordinary redirect. */
export async function me(sessionToken: string): Promise<MeResponse | null> {
  const { status, json } = await call({
    method: 'GET',
    path: '/v1/auth/me',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 401],
  });
  if (status === 401) return null;
  return meResponse.parse(json);
}

/**
 * Revoke server-side. Throws on anything but a clean 204, so a sign-out that
 * did not actually revoke can never be reported as one.
 */
export async function signOut(sessionToken: string): Promise<void> {
  await call({
    method: 'DELETE',
    path: '/v1/auth/session',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [204],
  });
}

/* ── the Payment Hub (docs/payments-v1.md §3–5, §35) ─────────────────────── */

export async function paymentConnection(sessionToken: string): Promise<PaymentConnectionResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/connection',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return paymentConnectionResponse.parse(json);
}

export type SubmitConnectionOutcome =
  | { state: 'submitted'; connection: PaymentConnectionResponse; held: boolean }
  | { state: 'invalid' }
  | { state: 'unavailable' };

export async function submitPaymentConnection(
  sessionToken: string,
  input: SubmitConnectionRequest,
): Promise<SubmitConnectionOutcome> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/payments/connection',
    body: input,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400, 503],
  });
  if (status === 400) return { state: 'invalid' };
  if (status === 503) return { state: 'unavailable' };
  const parsed = paymentConnectionResponse.parse(json);
  const held = typeof json === 'object' && json !== null && 'held' in json;
  return { state: 'submitted', connection: parsed, held };
}

export async function paymentsList(sessionToken: string): Promise<PaymentsListResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/list',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return paymentsListResponse.parse(json);
}

export async function paymentExceptions(sessionToken: string): Promise<PaymentExceptionsResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/exceptions',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return paymentExceptionsResponse.parse(json);
}

/* ── the dashboard's numbers (all computed by SQL in the API tier) ───────── */

export async function reportsOverview(sessionToken: string): Promise<ReportsOverviewResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/overview',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsOverviewResponse.parse(json);
}

export async function reportsCashflow(sessionToken: string): Promise<ReportsCashflowResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/cashflow',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsCashflowResponse.parse(json);
}

export async function reportsDebtors(sessionToken: string): Promise<ReportsDebtorsResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/debtors',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsDebtorsResponse.parse(json);
}

export async function reportsActivity(sessionToken: string): Promise<ReportsActivityResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/activity',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsActivityResponse.parse(json);
}

/**
 * The team, and changes to it.
 *
 * Owner only at the API, so a non-owner reaching these gets a 403 rather
 * than an empty list: "you cannot" and "there is nobody" are different
 * answers and the page says which.
 */
export async function businessMembers(sessionToken: string): Promise<TeamResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/businesses/members',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return teamResponse.parse(json);
}

export async function inviteBusinessMember(
  sessionToken: string,
  phone: string,
  role: 'accountant' | 'delegate',
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/businesses/members',
    headers: { authorization: `Bearer ${sessionToken}` },
    body: { phone, role },
    expect: [201, 400, 409],
  });
  if (status === 201) return { ok: true };
  /* The server's sentence, whichever refusal this was: a 409 is "already a
   * member" OR "your plan's seats are full", and hardcoding the first turned
   * the second into a lie on the form. */
  const message = (json as { message?: string })?.message;
  return {
    ok: false,
    reason:
      message ??
      (status === 409
        ? 'That number already has access to this business.'
        : 'That does not look like a Nigerian phone number.'),
  };
}

export async function removeBusinessMember(sessionToken: string, userId: string): Promise<boolean> {
  const { json } = await call({
    method: 'DELETE',
    path: `/v1/businesses/members/${encodeURIComponent(userId)}`,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return (json as { removed?: boolean })?.removed === true;
}

export async function reportsInvoices(sessionToken: string): Promise<ReportsInvoicesResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/invoices',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsInvoicesResponse.parse(json);
}

export async function reportsReceipts(sessionToken: string): Promise<ReportsReceiptsResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/receipts',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsReceiptsResponse.parse(json);
}

/**
 * Exchange a tapped sign-in link for a session.
 *
 * Every failure comes back as `invalid` rather than a status code, so the
 * page cannot accidentally tell somebody guessing whether a link expired, was
 * already used, or never existed.
 */
export async function redeemMagicLink(token: string): Promise<MagicRedeemResponse> {
  const { json } = await call({
    method: 'POST',
    path: '/v1/auth/magic/redeem',
    body: { token },
    expect: [200],
  });
  return magicRedeemResponse.parse(json);
}

export async function reportsAudit(sessionToken: string): Promise<ReportsAuditResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/audit',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsAuditResponse.parse(json);
}

/** A payment the merchant is reporting, against the invoice it settles. */
export async function recordPayment(
  sessionToken: string,
  body: {
    invoiceNumber: string;
    amountK: number;
    method: 'cash' | 'transfer';
    clientRef?: string;
  },
): Promise<RecordPaymentResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/payments/record',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? recordPaymentResponse.parse(json) : null;
}

/** Buying something the business keeps and uses (ADR 0026). */
export async function recordAsset(
  sessionToken: string,
  body: RecordAssetRequest,
): Promise<RecordAssetResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/assets',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? recordAssetResponse.parse(json) : null;
}

/** Selling or scrapping something the business owned. */
export async function disposeAsset(
  sessionToken: string,
  body: { assetId: string; proceedsK: number; method: 'cash' | 'transfer' },
): Promise<DisposeAssetResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/assets/dispose',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? disposeAssetResponse.parse(json) : null;
}

/** Take one back out. Not a disposal. */
export async function withdrawAsset(
  sessionToken: string,
  body: { assetId: string; reason: string },
): Promise<WithdrawAssetResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/assets/withdraw',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? withdrawAssetResponse.parse(json) : null;
}

/** Money going back to a supplier, against the purchase it settles. */
export async function paySupplier(
  sessionToken: string,
  body: { expenseId: string; amountK: number; method: 'cash' | 'transfer'; clientRef?: string },
): Promise<PaySupplierResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/suppliers/pay',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? paySupplierResponse.parse(json) : null;
}

export async function reportsExpenses(sessionToken: string): Promise<ReportsExpensesResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/expenses',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsExpensesResponse.parse(json);
}

export async function reportsStock(sessionToken: string): Promise<ReportsStockResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/reports/stock',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsStockResponse.parse(json);
}

export async function usageMeter(sessionToken: string): Promise<UsageMeterResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/payments/usage',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return usageMeterResponse.parse(json);
}

export async function reportsStatements(
  sessionToken: string,
  period?: string,
): Promise<ReportsStatementsResponse> {
  const query = period ? `?period=${encodeURIComponent(period)}` : '';
  const { json } = await call({
    method: 'GET',
    path: `/v1/reports/statements${query}`,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return reportsStatementsResponse.parse(json);
}

/** Owner action: mark one reconciliation exception reviewed. */
export async function resolvePaymentException(
  sessionToken: string,
  exceptionId: string,
): Promise<'resolved' | 'not_found'> {
  const { status } = await call({
    method: 'POST',
    path: `/v1/payments/exceptions/${encodeURIComponent(exceptionId)}/resolve`,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 404],
  });
  return status === 200 ? 'resolved' : 'not_found';
}

/* ── billing (ADR 0024) ───────────────────────────────────────────────────── */

export async function billingOverview(sessionToken: string): Promise<BillingOverviewResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/billing',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return billingOverviewResponse.parse(json);
}

/** What a plan change costs, before the merchant commits to it. */
export async function billingQuote(
  sessionToken: string,
  plan: string,
): Promise<BillingQuoteResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/billing/quote',
    body: { plan },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? billingQuoteResponse.parse(json) : null;
}

export async function billingChangePlan(
  sessionToken: string,
  plan: string,
): Promise<BillingPlanChangeResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/billing/plan',
    body: { plan },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? billingPlanChangeResponse.parse(json) : null;
}

export type BuyPackOutcome =
  | { state: 'payment_required'; reference: string; amountK: number }
  | { state: 'unavailable'; reason: string };

export async function billingBuyPack(
  sessionToken: string,
  packId: string,
): Promise<BuyPackOutcome | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/billing/packs',
    body: { packId },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? (json as BuyPackOutcome) : null;
}

/** Cancel the subscription: a scheduled stop on the day already paid to. */
export async function billingCancel(sessionToken: string): Promise<BillingCancelResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/billing/cancel',
    body: {},
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? billingCancelResponse.parse(json) : null;
}

/** The facts the settings page edits. Owner-only, like the write. */
export async function businessSettings(sessionToken: string): Promise<BusinessSettingsView> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/businesses/settings',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return businessSettingsView.parse(json);
}

export async function updateBusinessSettings(
  sessionToken: string,
  body: BusinessSettingsRequest,
): Promise<BusinessSettingsResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/businesses/settings',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? businessSettingsResponse.parse(json) : null;
}
/**
 * Withdraw an invoice. Returns null on a request the API refused outright,
 * which the caller reports as a sentence rather than an error page.
 */
export async function voidExpense(
  sessionToken: string,
  expenseId: string,
  reason: string,
): Promise<VoidExpenseResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/expenses/void',
    body: { expenseId, reason },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? voidExpenseResponse.parse(json) : null;
}

/**
 * A shop, by slug, with no session anywhere.
 *
 * The one read in this file that carries no token, because the page it feeds
 * is public. Null when there is no such published shop, which the route turns
 * into an ordinary 404 rather than an error.
 */
export async function publicShop(slug: string, page = 1): Promise<PublicShopResponse | null> {
  const query = page > 1 ? `?page=${page}` : '';
  const { status, json } = await call({
    method: 'GET',
    path: `/v1/shop/${encodeURIComponent(slug)}${query}`,
    expect: [200, 404],
  });
  return status === 200 ? publicShopResponse.parse(json) : null;
}

/**
 * Every open shop, for the sitemap.
 *
 * The only read in this file with neither a token nor an argument. It is also
 * the only one whose failure is routine rather than exceptional: the caller
 * catches it and ships a shorter file, so this stays a plain throw and does
 * not invent a null.
 */
export async function publicShopIndex(): Promise<PublicShopIndexResponse> {
  const { json } = await call({ method: 'GET', path: '/v1/shops', expect: [200] });
  return publicShopIndexResponse.parse(json);
}

/**
 * Open the books: what the business was already holding.
 *
 * `expect` carries 200 alone because every refusal is an outcome rather than
 * a status: already open, nothing to open, dated in the future. A 4xx here
 * would mean the merchant typed something the form should have caught.
 */
export async function openBooks(
  sessionToken: string,
  body: OpeningBalancesRequest,
): Promise<OpeningBalancesResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/opening-balances',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? openingBalancesResponse.parse(json) : null;
}

/**
 * Act on a count of the shelf.
 *
 * Carries the day and nothing else, on purpose. The count and the ledger
 * balance are read on the server inside the transaction that writes the
 * entry, so a page left open for an hour cannot post an hour-old figure.
 */
export async function countStock(
  sessionToken: string,
  body: StockCountRequest,
): Promise<StockCountResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/stock-count',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? stockCountResponse.parse(json) : null;
}

/**
 * Close the books through a month, so a statement already sent cannot change.
 *
 * `expect` carries 200 alone because every refusal here is an outcome rather
 * than a status: the month has not ended, or it was closed already.
 */
export async function closeBooks(
  sessionToken: string,
  body: CloseBooksRequest,
): Promise<CloseBooksResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/close',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? closeBooksResponse.parse(json) : null;
}

/**
 * A correction written by hand.
 *
 * `expect` carries 200 alone because every refusal is an outcome rather than
 * a status: the same account twice, a day that has not happened, a month that
 * is closed. A 4xx would mean the form should have caught it.
 */
export async function recordJournal(
  sessionToken: string,
  body: JournalEntryRequest,
): Promise<JournalEntryResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/journal',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? journalEntryResponse.parse(json) : null;
}

/** What the books say against what the bank says. */
export async function bankPosition(sessionToken: string): Promise<BankPositionResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/bank/position',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return bankPositionResponse.parse(json);
}

/**
 * Send a statement the merchant picked, as text.
 *
 * The bytes are already here by the time a server action runs, so they are
 * converted once and the API stays a JSON surface. `expect` carries 200
 * alone because an unreadable file is an outcome the page has to explain,
 * not a status code.
 */
export async function importStatement(
  sessionToken: string,
  csv: string,
): Promise<ImportStatementResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/statement',
    body: { csv },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? importStatementResponse.parse(json) : null;
}

/** The live feed's standing state, for the card the bank page renders. */
export async function bankFeedState(sessionToken: string): Promise<BankFeedStateResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/bank/feed',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return bankFeedStateResponse.parse(json);
}

/** Exchange the consent widget's one-time code for a standing link. */
export async function connectBankFeed(
  sessionToken: string,
  exchangeCode: string,
): Promise<ConnectBankFeedResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/feed/connect',
    body: { exchangeCode },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? connectBankFeedResponse.parse(json) : null;
}

/** Pull what moved since the last sync, through the same import as the CSV. */
export async function syncBankFeed(sessionToken: string): Promise<SyncBankFeedResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/feed/sync',
    body: {},
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? syncBankFeedResponse.parse(json) : null;
}

/** Pair what can only be paired one way. A write, so it is asked for. */
export async function reconcileBank(sessionToken: string): Promise<ReconcileResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/reconcile',
    body: {},
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? reconcileResponse.parse(json) : null;
}

/** A merchant deciding what the rule would not. */
export async function matchBankLine(
  sessionToken: string,
  body: MatchLineRequest,
): Promise<MatchLineResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/match',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? matchLineResponse.parse(json) : null;
}

/** Release a pairing, leaving the line and the posting as they were. */
export async function unmatchBankLine(
  sessionToken: string,
  lineId: string,
): Promise<UnmatchLineResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/unmatch',
    body: { lineId },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? unmatchLineResponse.parse(json) : null;
}

/** Take one day's imported lines back out. */
export async function forgetStatementDay(
  sessionToken: string,
  postedOn: string,
): Promise<ForgetStatementDayResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/bank/statement/forget',
    body: { postedOn },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? forgetStatementDayResponse.parse(json) : null;
}

/** Open a closed month, and every month after it. */
export async function reopenBooks(
  sessionToken: string,
  body: ReopenBooksRequest,
): Promise<ReopenBooksResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/reopen',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? reopenBooksResponse.parse(json) : null;
}

/** The merchant's own shop settings. */
export async function shopSettings(sessionToken: string): Promise<ShopSettingsResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/shop-settings',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return shopSettingsResponse.parse(json);
}

export async function saveShop(
  sessionToken: string,
  input: SaveShopRequest,
): Promise<SaveShopResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/shop-settings',
    body: input,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? saveShopResponse.parse(json) : null;
}

/** Everything the shop could sell, listed and hidden alike. */
export async function catalogue(sessionToken: string): Promise<CatalogueResponse> {
  const { json } = await call({
    method: 'GET',
    path: '/v1/catalogue',
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200],
  });
  return catalogueResponse.parse(json);
}

/** Change what the shop says about one product. */
export async function editProduct(
  sessionToken: string,
  input: EditProductRequest,
): Promise<EditProductResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/catalogue/product',
    body: input,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? editProductResponse.parse(json) : null;
}

/**
 * Send a product photo through to the API, still as a file.
 *
 * Deliberately not `call`, which serialises JSON: re-encoding an image as
 * base64 to fit a JSON body would inflate it by a third and buffer the whole
 * thing as a string on the way past. `fetch` sets the multipart boundary
 * itself from the FormData, which is why no content-type is set here.
 */
export async function uploadProductImage(
  sessionToken: string,
  productId: string,
  file: File,
): Promise<UploadImageResponse | null> {
  const body = new FormData();
  body.set('file', file, file.name);

  let response: Response;
  try {
    response = await fetch(`${BASE}/v1/catalogue/${productId}/image`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}` },
      body,
      cache: 'no-store',
    });
  } catch (cause) {
    throw new ApiUnavailable(`cannot reach the Rekoda API at ${BASE}`, { cause });
  }
  if (response.status !== 200) return null;
  const json: unknown = await response.json().catch(() => null);
  const parsed = uploadImageResponse.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Set up a cost that repeats. Null when the API refused the shape outright,
 * which the caller turns into a sentence rather than an error page.
 */
export async function createRecurring(
  sessionToken: string,
  input: CreateRecurringRequest,
): Promise<CreateRecurringResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/expenses/recurring',
    body: input,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? createRecurringResponse.parse(json) : null;
}

export async function stopRecurring(
  sessionToken: string,
  id: string,
): Promise<StopRecurringResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/expenses/recurring/stop',
    body: { id },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? stopRecurringResponse.parse(json) : null;
}

export async function createQuote(
  sessionToken: string,
  body: CreateQuoteRequest,
): Promise<CreateQuoteResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/quotes',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? createQuoteResponse.parse(json) : null;
}

export async function convertQuote(
  sessionToken: string,
  quoteNumber: string,
): Promise<ConvertQuoteResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/quotes/convert',
    body: { quoteNumber },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? convertQuoteResponse.parse(json) : null;
}

export async function cancelQuote(
  sessionToken: string,
  quoteNumber: string,
): Promise<CancelQuoteResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/quotes/cancel',
    body: { quoteNumber },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? cancelQuoteResponse.parse(json) : null;
}

export async function createPurchaseOrder(
  sessionToken: string,
  body: CreatePurchaseOrderRequest,
): Promise<CreatePurchaseOrderResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/purchase-orders',
    body,
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? createPurchaseOrderResponse.parse(json) : null;
}

export async function receivePurchaseOrder(
  sessionToken: string,
  poNumber: string,
  paidK: number,
): Promise<ReceivePurchaseOrderResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/purchase-orders/receive',
    body: { poNumber, paidK },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? receivePurchaseOrderResponse.parse(json) : null;
}

export async function cancelPurchaseOrder(
  sessionToken: string,
  poNumber: string,
): Promise<CancelPurchaseOrderResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/purchase-orders/cancel',
    body: { poNumber },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? cancelPurchaseOrderResponse.parse(json) : null;
}

export async function creditInvoice(
  sessionToken: string,
  invoiceNumber: string,
  amountK: number,
  reason: string,
  clientRef?: string,
): Promise<CreditInvoiceResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/invoices/credit',
    body: { invoiceNumber, amountK, reason, ...(clientRef ? { clientRef } : {}) },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? creditInvoiceResponse.parse(json) : null;
}

export async function voidInvoice(
  sessionToken: string,
  invoiceNumber: string,
  reason: string,
): Promise<VoidInvoiceResponse | null> {
  const { status, json } = await call({
    method: 'POST',
    path: '/v1/reports/invoices/void',
    body: { invoiceNumber, reason },
    headers: { authorization: `Bearer ${sessionToken}` },
    expect: [200, 400],
  });
  return status === 200 ? voidInvoiceResponse.parse(json) : null;
}
