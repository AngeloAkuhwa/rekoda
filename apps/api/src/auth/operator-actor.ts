import { BadRequestException } from '@nestjs/common';
import type { OperatorRequest } from './operator.guard.js';

/**
 * What an operator-plane subject may be when it is recorded as an audit actor: 1 to 255 printable
 * ASCII characters with no space. This is the same rule the operator plan writer enforces in the
 * database (`^operator:[!-~]{1,255}$`, migrations 0200 and 0203), so a subject the database would
 * refuse is refused here first, as the caller's problem (400), instead of surfacing as a 500.
 */
const AUDITABLE_SUBJECT = /^[!-~]{1,255}$/;

/**
 * The audit actor for a request that passed `OperatorGuard`: `operator:<subject>`.
 *
 * - A subject the identity provider issued but that cannot be recorded (empty, too long, spaces,
 *   control or non-ASCII characters) is a client error: 400, before any write is attempted.
 * - A request with no verified operator at all means the route was reached without the guard,
 *   which is a server defect, so it stays a 500 and is never dressed up as the caller's mistake.
 */
export function operatorActor(request: OperatorRequest): string {
  const operator = request.operator;
  if (!operator) {
    throw new Error('operator route reached without a verified operator identity');
  }
  if (typeof operator.subject !== 'string' || !AUDITABLE_SUBJECT.test(operator.subject)) {
    throw new BadRequestException(
      'the operator identity subject cannot be recorded as an audit actor: it must be 1 to 255 printable characters with no spaces',
    );
  }
  return `operator:${operator.subject}`;
}
