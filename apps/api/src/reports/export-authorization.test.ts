/**
 * Every route that hands back a FILE must say who may have it.
 *
 * `RolesGuard` treats a route with no `@Roles` metadata as open to every
 * member (roles.guard.ts) — a sensible default for the dozens of ordinary
 * read routes, and a trap for exports: "deliberately open to everyone" and
 * "the author forgot" produce identical code. Nine of the ten exports on
 * this controller were in the second state, including `audit.csv`.
 *
 * So the declaration is now mandatory rather than remembered. This test
 * reads the routes back off the controller through Nest's own metadata and
 * fails if a file-producing route ships without an explicit audience. Add
 * a new export tomorrow and forget the decorator, and this goes red before
 * a merchant's books go anywhere.
 *
 * It also pins the matrix itself, so a change of audience is a deliberate
 * edit to a table someone reviews rather than a decorator quietly deleted.
 */
import { describe, expect, it } from 'vitest';
import { ROLES_KEY, type Role } from '../auth/roles.guard.js';
import { ReportsController } from './reports.controller.js';

/** Nest's own metadata key for the path a handler answers on. */
const PATH_METADATA = 'path';

interface RouteHandler {
  method: string;
  path: string;
  roles: Role[] | undefined;
}

function routesOf(controller: new (...args: never[]) => unknown): RouteHandler[] {
  const prototype = controller.prototype as Record<string, unknown>;
  const found: RouteHandler[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const handler = descriptor?.value as ((...args: never[]) => unknown) | undefined;
    if (typeof handler !== 'function') continue;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    if (path === undefined) continue;
    found.push({
      method: name,
      path,
      roles: Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined,
    });
  }
  return found;
}

/**
 * A file, not a page. The controller's own rule is that a route producing
 * an artefact carries its extension in the path (and passes `takeExport`);
 * a page returns JSON from a bare path.
 */
const producesAFile = (path: string): boolean => /\.[a-z]+$/.test(path);

/**
 * The intended audience of every export, derived from the role semantics
 * the rest of the suite already pins: an accountant reads the books and
 * reconciles them, a delegate records the day's trade, the owner does
 * everything. Keep this table and the decorators in step; the test below
 * is what makes that mutual.
 */
const INTENDED: Record<string, Role[]> = {
  'statements.pdf': ['owner', 'accountant', 'delegate'],
  'statements.xlsx': ['owner', 'accountant', 'delegate'],
  'invoices.csv': ['owner', 'accountant', 'delegate'],
  'customers/:customerId/statement.csv': ['owner', 'accountant', 'delegate'],
  'suppliers/:supplierId/statement.csv': ['owner', 'accountant', 'delegate'],
  'expenses.csv': ['owner', 'accountant', 'delegate'],
  'receipts.csv': ['owner', 'accountant', 'delegate'],
  'stock.csv': ['owner', 'accountant', 'delegate'],
  /* Colleagues' roles and phone tails, plus every correction the owner
   * ever made. Narrower on purpose. */
  'audit.csv': ['owner', 'accountant'],
  /* The whole business in one file, and never metered. Owner only. */
  'portability.json': ['owner'],
};

describe('every export declares who may download it', () => {
  const exports = routesOf(ReportsController).filter((route) => producesAFile(route.path));

  it('finds the exports at all, so a rename cannot empty this suite', () => {
    expect(exports.length).toBe(Object.keys(INTENDED).length);
  });

  it('leaves no file-producing route to the fail-open default', () => {
    const undeclared = exports.filter((route) => !route.roles || route.roles.length === 0);
    expect(undeclared.map((route) => route.path)).toEqual([]);
  });

  it.each(Object.entries(INTENDED))(
    '%s is readable by exactly the intended roles',
    (path, roles) => {
      const route = exports.find((candidate) => candidate.path === path);
      expect(route, `no route serves ${path}`).toBeDefined();
      expect([...(route!.roles ?? [])].sort()).toEqual([...roles].sort());
    },
  );

  it('keeps the audit trail away from the delegate on both surfaces', () => {
    /* The CSV is checked above; the JSON page it downloads from must not be
     * the way around it. */
    const page = routesOf(ReportsController).find((route) => route.path === 'audit');
    expect(page?.roles).toBeDefined();
    expect(page!.roles).not.toContain('delegate');
  });
});
