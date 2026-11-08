/**
 * Staging test-business tools (G-119 / OWN-77). `ops:staging` on every route; the service refuses,
 * writing nothing, unless the deployment and the database are both staging (see the service).
 *
 *   POST /v1/ops/staging/businesses/:businessId/designate                 { reason }
 *   POST /v1/ops/staging/businesses/:businessId/dates                     { field, expected, to, reason }
 *   POST /v1/ops/staging/businesses/:businessId/actions/:actionId/revert  { reason }
 *   POST /v1/ops/staging/businesses/:businessId/faults                    { kind, reason }
 *   GET  /v1/ops/staging/businesses/:businessId/actions
 *
 * The operator's procedure, and the acceptance scenarios it serves, are in
 * docs/runbooks/staging-test-business-tools.md.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  opsStagingArmFaultRequest,
  opsStagingDesignateRequest,
  opsStagingMoveDateRequest,
  opsStagingRevertRequest,
  type OpsStagingActionView,
} from '@rekoda/contracts';
import { OperatorGuard, OperatorScopes, type OperatorRequest } from '../auth/operator.guard.js';
import { StagingRefused, StagingToolsService } from './staging-tools.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/ops/staging')
@UseGuards(OperatorGuard)
export class StagingToolsController {
  constructor(@Inject(StagingToolsService) private readonly tools: StagingToolsService) {}

  @Post('businesses/:businessId/designate')
  @OperatorScopes('ops:staging')
  @HttpCode(200)
  async designate(
    @Req() request: OperatorRequest,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const id = uuid(businessId);
    const input = parse(opsStagingDesignateRequest, body);
    return refusals(() => this.tools.designate(id, operatorOf(request), input.reason));
  }

  @Post('businesses/:businessId/dates')
  @OperatorScopes('ops:staging')
  @HttpCode(200)
  async moveDate(
    @Req() request: OperatorRequest,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ) {
    const id = uuid(businessId);
    const input = parse(opsStagingMoveDateRequest, body);
    return refusals(() =>
      this.tools.moveDate(
        id,
        {
          field: input.field,
          expected: input.expected ? new Date(input.expected) : null,
          to: new Date(input.to),
          reason: input.reason,
        },
        operatorOf(request),
      ),
    );
  }

  @Post('businesses/:businessId/actions/:actionId/revert')
  @OperatorScopes('ops:staging')
  @HttpCode(200)
  async revert(
    @Req() request: OperatorRequest,
    @Param('businessId') businessId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    const id = uuid(businessId);
    const action = uuid(actionId);
    const input = parse(opsStagingRevertRequest, body);
    return refusals(() => this.tools.revert(id, action, operatorOf(request), input.reason));
  }

  @Post('businesses/:businessId/faults')
  @OperatorScopes('ops:staging')
  @HttpCode(200)
  async armFault(
    @Req() request: OperatorRequest,
    @Param('businessId') businessId: string,
    @Body() body: unknown,
  ): Promise<{ armed: true; kind: 'send_timeout' | 'sender_refused' }> {
    const id = uuid(businessId);
    const input = parse(opsStagingArmFaultRequest, body);
    return refusals(() => this.tools.armFault(id, input.kind, operatorOf(request), input.reason));
  }

  @Get('businesses/:businessId/actions')
  @OperatorScopes('ops:staging')
  async actions(
    @Param('businessId') businessId: string,
  ): Promise<{ actions: OpsStagingActionView[] }> {
    const id = uuid(businessId);
    const rows = await refusals(() => this.tools.actions(id));
    return {
      actions: rows.map((a) => ({
        id: a.id,
        businessId: a.businessId,
        operator: a.operator,
        action: a.action,
        field: a.field,
        before: a.before?.toISOString() ?? null,
        after: a.after?.toISOString() ?? null,
        reason: a.reason,
        outcome: a.outcome,
        revertsActionId: a.revertsActionId,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  }
}

const operatorOf = (request: OperatorRequest) => `operator:${request.operator!.subject}`;

function uuid(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('not an id');
  return value;
}

function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new BadRequestException('the request does not match the expected shape');
  return result.data;
}

async function refusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof StagingRefused)) throw error;
    switch (error.reason) {
      case 'disabled':
      case 'not_staging':
      case 'not_test_business':
        throw new ForbiddenException(error.message);
      case 'no_business':
      case 'no_action':
        throw new NotFoundException(error.message);
      case 'changed':
      case 'already_armed':
      case 'already_reverted':
        throw new ConflictException(error.message);
      default:
        throw new UnprocessableEntityException(error.message);
    }
  }
}
