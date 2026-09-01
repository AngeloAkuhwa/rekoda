/**
 * The operator plane's authority, pinned (P0-2).
 *
 * These routes can refund any merchant, resolve any payment exception and
 * change any business's plan. Until this PR the whole of that authority was
 * one reusable static header secret, and the audit row said whatever the
 * caller typed into an `actor` field. Two separate failures wearing one
 * shape: possession is not identity, and a claim is not a fact.
 *
 * What is asserted here is the DECLARATION rather than the cryptography.
 * jose verifies signatures, issuers, audiences and expiry, and re-testing
 * a library's own guarantees proves nothing about this repository. What no
 * library can notice is an operator route somebody adds without saying what
 * authority it needs, which is exactly the mistake that turns a scoped plane
 * back into a master key.
 */
import { describe, expect, it } from 'vitest';
import { OpsController } from '../health/ops.controller.js';
import { BusinessController } from './auth.controller.js';
import { OPERATOR_SCOPES, type OperatorScope } from './operator-identity.js';
import { OPERATOR_SCOPES_KEY } from './operator.guard.js';

/** Nest's own metadata keys, read back off the class. */
const PATH = 'path';
const METHOD = 'method';

interface Route {
  name: string;
  path: string;
  scopes: OperatorScope[] | undefined;
}

function routesOf(controller: new (...args: never[]) => object): Route[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = proto[name] as object;
      return {
        name,
        path: (Reflect.getMetadata(PATH, handler) as string) ?? '',
        scopes: Reflect.getMetadata(OPERATOR_SCOPES_KEY, handler) as OperatorScope[] | undefined,
      };
    })
    .filter((route) => Reflect.getMetadata(METHOD, proto[route.name] as object) !== undefined);
}

describe('every operator route declares the authority it needs', () => {
  it('leaves no route on the ops plane undeclared', () => {
    const undeclared = routesOf(OpsController)
      .filter((route) => !route.scopes || route.scopes.length === 0)
      .map((route) => route.name);
    expect(undeclared).toEqual([]);
  });

  it('declares only scopes that exist', () => {
    for (const route of routesOf(OpsController)) {
      for (const scope of route.scopes ?? []) {
        expect(OPERATOR_SCOPES).toContain(scope);
      }
    }
  });

  /**
   * The matrix itself, so a change of authority is an edit somebody reviews
   * rather than a decorator quietly widened. Reads take `ops:read`; the two
   * routes that move money take `ops:payment`.
   */
  it('pins which routes may move money', () => {
    const byName = new Map(routesOf(OpsController).map((route) => [route.name, route.scopes]));
    expect(byName.get('refund')).toEqual(['ops:payment']);
    expect(byName.get('resolveException')).toEqual(['ops:payment']);
    expect(byName.get('health')).toEqual(['ops:read']);
    expect(byName.get('marginReport')).toEqual(['ops:read']);
    expect(byName.get('businessBilling')).toEqual(['ops:read']);
  });

  it('puts the plan change on billing authority, not on read', () => {
    const byName = new Map(routesOf(BusinessController).map((route) => [route.name, route.scopes]));
    expect(byName.get('setPlan')).toEqual(['ops:billing']);
  });
});

/**
 * A valid operator token is not a master key.
 *
 * Five scopes rather than one flag, because "authenticated" and "may refund
 * every merchant in the estate" are different questions and answering them
 * with one boolean is how an operator plane becomes a single point of total
 * authority.
 */
describe('the scope vocabulary', () => {
  it('separates reading from money, privacy, billing and security', () => {
    expect([...OPERATOR_SCOPES]).toEqual([
      'ops:read',
      'ops:payment',
      'ops:privacy',
      'ops:billing',
      'ops:security',
    ]);
  });
});
