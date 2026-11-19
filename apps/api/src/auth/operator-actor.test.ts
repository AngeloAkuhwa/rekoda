/**
 * Owner review of PR #432, item 4.1: an operator-plane subject that cannot be recorded as an audit
 * actor is the caller's problem (400), checked before anything is written, instead of surfacing as
 * a 500 from the database writer's own actor check. A route reached without a verified operator is a
 * server defect and stays a 500.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { operatorActor } from './operator-actor.js';
import { BusinessController } from './auth.controller.js';
import type { OperatorRequest } from './operator.guard.js';

const request = (subject: unknown): OperatorRequest =>
  ({ operator: { subject, scopes: ['ops:billing'] } }) as unknown as OperatorRequest;

describe('operatorActor', () => {
  it.each([
    ['an OIDC email subject', 'ada@rekoda.app'],
    ['the local operator secret', 'local:operator-secret'],
    ['an opaque provider id', 'auth0|65f1c0de9a'],
    ['the longest recordable subject', 's'.repeat(255)],
  ])('records %s as operator:<subject>', (_label, subject) => {
    expect(operatorActor(request(subject))).toBe(`operator:${subject}`);
  });

  it.each([
    ['empty', ''],
    ['too long', 's'.repeat(256)],
    ['with a space', 'ada lovelace'],
    ['with a newline', 'ada\nadmin'],
    ['with a tab', 'ada\tx'],
    ['non-ASCII', 'adá@rekoda.app'],
    ['a control character', 'ada\u0007'],
    ['not a string', 42],
    ['missing', undefined],
  ])('refuses a subject that is %s with a 400', (_label, subject) => {
    expect(() => operatorActor(request(subject))).toThrow(BadRequestException);
    try {
      operatorActor(request(subject));
    } catch (error) {
      expect((error as BadRequestException).getStatus()).toBe(400);
    }
  });

  it('a request with no verified operator is a server defect (500), not a client error', () => {
    const bare = {} as OperatorRequest;
    expect(() => operatorActor(bare)).toThrow(Error);
    expect(() => operatorActor(bare)).not.toThrow(BadRequestException);
  });
});

describe('POST /v1/businesses/plan with an unrecordable subject', () => {
  it('answers 400 before any database work, and a valid subject reaches the operator pool', async () => {
    const operatorDb = {
      transaction: vi.fn(() => Promise.reject(new Error('reached the database'))),
    };
    const controller = new BusinessController(
      {} as never,
      {} as never,
      {} as never,
      operatorDb as never,
    );
    const body = {
      businessId: '2b0f9b6a-0000-4000-8000-000000000000',
      plan: 'chat',
      expiresAt: null,
    };

    await expect(controller.setPlan(request('ada lovelace'), body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(operatorDb.transaction).not.toHaveBeenCalled();

    // A valid subject gets as far as the database (which this stub refuses): no 400 is invented.
    await expect(controller.setPlan(request('ada@rekoda.app'), body)).rejects.toThrow(
      'reached the database',
    );
    expect(operatorDb.transaction).toHaveBeenCalledTimes(1);
  });

  it('answers 503, never the application pool, when this process holds no operator credential', async () => {
    const controller = new BusinessController({} as never, {} as never, {} as never, null);
    const body = {
      businessId: '2b0f9b6a-0000-4000-8000-000000000000',
      plan: 'chat',
      expiresAt: null,
    };
    await expect(controller.setPlan(request('ada@rekoda.app'), body)).rejects.toMatchObject({
      status: 503,
    });
  });
});
