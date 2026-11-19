/**
 * `POST /v1/ops/privacy/email-erasure` (OD-39): an authorised operator erases one email address.
 * Scope `ops:privacy`; the audit actor is the VERIFIED operator subject, never a name in the body.
 * See `email-erasure.service.ts` for what is erased and what is kept.
 */
import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { opsEmailErasureRequest, type OpsEmailErasureResponse } from '@rekoda/contracts';
import { OperatorGuard, OperatorScopes, type OperatorRequest } from '../auth/operator.guard.js';
import {
  EmailErasureService,
  ErasureBusinessNotFound,
  ERASURE_SEAL_UNREADABLE_MESSAGE,
  ErasureSealUnreadable,
} from './email-erasure.service.js';
import { operatorActor } from '../auth/operator-actor.js';

@Controller('v1/ops/privacy')
@UseGuards(OperatorGuard)
export class EmailErasureController {
  constructor(@Inject(EmailErasureService) private readonly erasure: EmailErasureService) {}

  @Post('email-erasure')
  @OperatorScopes('ops:privacy')
  @HttpCode(200)
  async erase(
    @Req() request: OperatorRequest,
    @Body() body: unknown,
  ): Promise<OpsEmailErasureResponse> {
    const input = opsEmailErasureRequest.safeParse(body);
    if (!input.success) {
      /* The body is never echoed: it carries the address. */
      throw new BadRequestException(
        'address, reason (erasure_request or limit_cleared) and an optional businessId are required',
      );
    }
    try {
      return await this.erasure.erase(input.data, operatorActor(request));
    } catch (error) {
      if (error instanceof ErasureBusinessNotFound) throw new NotFoundException('no such business');
      if (error instanceof ErasureSealUnreadable) {
        /* The operator's next step, said plainly: a retry without businessId clears only the
         * shared counter and leaves this business's billing email stored. */
        throw new ConflictException(ERASURE_SEAL_UNREADABLE_MESSAGE);
      }
      throw error;
    }
  }
}
