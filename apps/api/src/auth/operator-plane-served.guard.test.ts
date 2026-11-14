/**
 * OD-51.1: an API process without the billing-operator credential does not serve the plan routes.
 * The check runs BEFORE the operator identity is read, so the API is never a second place a plan
 * token could be presented, and the same two operations stay reachable where one process holds
 * the credential (development and tests).
 */
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import type { Db } from '@rekoda/db';
import { describe, expect, it } from 'vitest';
import { BusinessController } from './auth.controller.js';
import { OperatorGuard } from './operator.guard.js';
import { OperatorPlaneServedHere } from './operator-plane-served.guard.js';

describe('the operator plan routes on an API process', () => {
  it('are a 404 when the process holds no operator credential', () => {
    expect(() => new OperatorPlaneServedHere(null).canActivate()).toThrow(NotFoundException);
  });

  it('are served where the process was given the credential', () => {
    expect(new OperatorPlaneServedHere({} as Db).canActivate()).toBe(true);
  });

  it('check that before the operator identity, on both plan routes', () => {
    for (const handler of ['setPlan', 'resolvePlanReview'] as const) {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        BusinessController.prototype[handler],
      ) as unknown[];
      expect(guards, handler).toEqual([OperatorPlaneServedHere, OperatorGuard]);
    }
  });
});
