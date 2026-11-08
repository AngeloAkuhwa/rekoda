/**
 * The operator routes for a payment or billing job that died (OWN-73, OWN-76).
 *
 * The work list itself is on `GET /v1/ops/exceptions` (`ops:read`): a dead job behind an event is
 * that event's flagged row, carrying `jobId`; a dead job with no event is a `deadJobs` row. These
 * two routes act on one, and both are `ops:payment`, the authority that moves payment state:
 *
 *   POST /v1/ops/dead-jobs/:jobId/recover  { reason }      verify with Paystack, then one attempt
 *   POST /v1/ops/dead-jobs/:jobId/resolve  { resolution }  close it without a recovery
 *
 * Both are conditional on the record still being open, so two operators produce one decision.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { opsDeadJobRecoverRequest, opsResolveEventRequest } from '@rekoda/contracts';
import { OperatorGuard, OperatorScopes, type OperatorRequest } from '../auth/operator.guard.js';
import { DeadJobRecoveryService } from './dead-job-recovery.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operator-facing words for each refusal. Never a provider response. */
const REFUSAL: Record<string, string> = {
  no_reference: 'this job has no Paystack reference to verify; settle it by hand and resolve it',
  invalid_reference: 'the event names a reference this kind of job does not process',
  verify_not_found: 'Paystack does not know this reference; nothing was recovered',
};

@Controller('v1/ops/dead-jobs')
@UseGuards(OperatorGuard)
export class DeadJobsController {
  constructor(@Inject(DeadJobRecoveryService) private readonly recovery: DeadJobRecoveryService) {}

  @Post(':jobId/recover')
  @OperatorScopes('ops:payment')
  @HttpCode(200)
  async recover(
    @Req() request: OperatorRequest,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ): Promise<{ recovering: true; jobId: string }> {
    if (!UUID.test(jobId)) throw new BadRequestException('not a job id');
    const input = opsDeadJobRecoverRequest.safeParse(body);
    if (!input.success)
      throw new BadRequestException('a reason of at least 4 characters is required');
    const result = await this.recovery.recover(
      jobId,
      `operator:${request.operator!.subject}`,
      input.data.reason,
    );
    switch (result.outcome) {
      case 'recovering':
        return { recovering: true as const, jobId: result.jobId };
      case 'no_worker':
        throw new ServiceUnavailableException('this process holds no worker credential');
      case 'not_found':
        throw new NotFoundException('no dead job with that id');
      case 'not_open':
        throw new ConflictException('that dead job is not open');
      case 'verify_unavailable':
        throw new ServiceUnavailableException('Paystack could not be reached; nothing changed');
      default:
        throw new UnprocessableEntityException(REFUSAL[result.outcome]);
    }
  }

  @Post(':jobId/resolve')
  @OperatorScopes('ops:payment')
  @HttpCode(200)
  async resolve(
    @Req() request: OperatorRequest,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ): Promise<{ resolved: true }> {
    if (!UUID.test(jobId)) throw new BadRequestException('not a job id');
    const input = opsResolveEventRequest.safeParse(body);
    if (!input.success) {
      throw new BadRequestException('a resolution of at least 4 characters is required');
    }
    const result = await this.recovery.resolve(
      jobId,
      `operator:${request.operator!.subject}`,
      input.data.resolution,
    );
    if (result.outcome === 'no_worker') {
      throw new ServiceUnavailableException('this process holds no worker credential');
    }
    if (result.outcome === 'not_found') throw new NotFoundException('no dead job with that id');
    if (result.outcome === 'not_open') throw new ConflictException('that dead job is not open');
    return { resolved: true as const };
  }
}
