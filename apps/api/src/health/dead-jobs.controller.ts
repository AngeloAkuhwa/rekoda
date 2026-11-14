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
 * And for the cutover enrolment's dead letters (0229): candidates whose record could not be written
 * after five attempts.
 *
 *   GET  /v1/ops/dead-jobs/enrolment-failures              (ops:read) the dead-lettered list
 *   POST /v1/ops/dead-jobs/:jobId/enrolment-requeue { reason }  (ops:payment) back in line, audited
 *
 * Both are conditional on the record still being open, so two operators produce one decision.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
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
import { operatorActor } from '../auth/operator-actor.js';

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

  @Get('enrolment-failures')
  @OperatorScopes('ops:read')
  async enrolmentFailures(): Promise<{ items: unknown[] }> {
    const result = await this.recovery.enrolmentFailures();
    if (result.outcome === 'no_worker') {
      throw new ServiceUnavailableException('this process holds no worker credential');
    }
    return {
      items: result.items.map((item) => ({
        jobId: item.jobId,
        businessId: item.businessId,
        kind: item.kind,
        attempts: item.attempts,
        lastSqlstate: item.lastSqlstate,
        lastFailedAt: item.lastFailedAt?.toISOString() ?? null,
        deadLetteredAt: item.deadLetteredAt.toISOString(),
        requeueCount: item.requeueCount,
      })),
    };
  }

  @Post(':jobId/enrolment-requeue')
  @OperatorScopes('ops:payment')
  @HttpCode(200)
  async requeueEnrolment(
    @Req() request: OperatorRequest,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ): Promise<{ requeued: true }> {
    if (!UUID.test(jobId)) throw new BadRequestException('not a job id');
    const input = opsDeadJobRecoverRequest.safeParse(body);
    if (!input.success)
      throw new BadRequestException('a reason of at least 4 characters is required');
    const result = await this.recovery.requeueEnrolment(
      jobId,
      operatorActor(request),
      input.data.reason,
    );
    if (result.outcome === 'no_worker') {
      throw new ServiceUnavailableException('this process holds no worker credential');
    }
    if (result.outcome === 'not_found') {
      throw new NotFoundException('no dead-lettered enrolment candidate with that id');
    }
    if (result.outcome === 'not_dead_lettered') {
      throw new ConflictException('that candidate is not dead-lettered');
    }
    return { requeued: true as const };
  }

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
    const result = await this.recovery.recover(jobId, operatorActor(request), input.data.reason);
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
      operatorActor(request),
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
