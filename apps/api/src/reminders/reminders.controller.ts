/**
 * Customer payment reminders (N1 slice A, OWN-43, OWN-62). Thin: the rules are in `@rekoda/core`
 * and the sequence in `ReminderService`. `businessId` comes from the session, never a body.
 *
 * Sending and stopping are for the owner and the delegate (day-to-day trade); an accountant reads.
 * The opt-out is the one public route: the signed token in the email is its only credential.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Inject,
  NotFoundException,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  createReminderBatchRequest,
  reminderBatchPreviewRequest,
  type CancelReminderBatchResponse,
  type ReminderBatchListResponse,
  type ReminderBatchPreviewResponse,
  type ReminderBatchResponse,
  paymentInstructionRequest,
  publicContactRequest,
  reminderOptOutRequest,
  sendReminderRequest,
  stopRemindersRequest,
  type PaymentInstructionResponse,
  type ReminderHistoryResponse,
  type SendReminderResponse,
} from '@rekoda/contracts';
import { AllMembers, Roles, RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import {
  BatchKeyReused,
  BatchNotFound,
  BatchRemindersNotReleased,
  BatchScheduleOutOfRange,
  BatchUnknownInvoices,
  ReminderBatchService,
} from './reminder-batch.service.js';
import { ReminderInvoiceNotFound, ReminderKeyReused, ReminderService } from './reminder.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/reminders')
@UseGuards(SessionGuard, RolesGuard)
export class RemindersController {
  constructor(
    @Inject(ReminderService) private readonly reminders: ReminderService,
    @Inject(ReminderBatchService) private readonly batches: ReminderBatchService,
  ) {}

  /* ── scheduled and bulk reminders (REM-05) ── */

  /** Who would be reminded, on which channel, and who is excluded and why. Writes and sends nothing. */
  @Post('batches/preview')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async previewBatch(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ReminderBatchPreviewResponse> {
    const parsed = reminderBatchPreviewRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invoiceNumbers_and_channels');
    return this.batches.preview(request.auth!.businessId, parsed.data);
  }

  /** The merchant's explicit confirmation (`confirm: true`): schedules the batch, sends nothing now. */
  @Post('batches')
  @Roles('owner', 'delegate')
  async createBatch(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ReminderBatchResponse> {
    const parsed = createReminderBatchRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('invoiceNumbers_channels_idempotencyKey_and_confirmation');
    }
    try {
      return await this.batches.create(request.auth!.businessId, request.auth!.userId, parsed.data);
    } catch (error) {
      if (error instanceof BatchUnknownInvoices) {
        throw new BadRequestException({
          error: 'invoice_not_found',
          invoiceNumbers: error.invoiceNumbers,
        });
      }
      if (error instanceof BatchScheduleOutOfRange) {
        throw new BadRequestException('scheduled_for_out_of_range');
      }
      if (error instanceof BatchKeyReused) throw new ConflictException('idempotency_key_reused');
      if (error instanceof BatchRemindersNotReleased) {
        throw new ConflictException('reminders_not_released');
      }
      throw error;
    }
  }

  @Get('batches')
  @AllMembers()
  async listBatches(@Req() request: AuthedRequest): Promise<ReminderBatchListResponse> {
    return this.batches.list(request.auth!.businessId);
  }

  @Get('batches/:id')
  @AllMembers()
  async getBatch(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<ReminderBatchResponse> {
    if (!UUID.test(id)) throw new NotFoundException('batch_not_found');
    try {
      return await this.batches.get(request.auth!.businessId, id);
    } catch (error) {
      if (error instanceof BatchNotFound) throw new NotFoundException('batch_not_found');
      throw error;
    }
  }

  /** Stops every recipient not yet dispatched. A batch already completed or cancelled is reported. */
  @Post('batches/:id/cancel')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async cancelBatch(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<CancelReminderBatchResponse> {
    if (!UUID.test(id)) throw new NotFoundException('batch_not_found');
    try {
      return await this.batches.cancel(request.auth!.businessId, request.auth!.userId, id);
    } catch (error) {
      if (error instanceof BatchNotFound) throw new NotFoundException('batch_not_found');
      throw error;
    }
  }

  @Post('send')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async send(@Req() request: AuthedRequest, @Body() body: unknown): Promise<SendReminderResponse> {
    const parsed = sendReminderRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invoiceNumber, channel and idempotencyKey');
    try {
      return await this.reminders.send(request.auth!.businessId, request.auth!.userId, parsed.data);
    } catch (error) {
      if (error instanceof ReminderInvoiceNotFound)
        throw new NotFoundException('invoice_not_found');
      if (error instanceof ReminderKeyReused) throw new ConflictException('idempotency_key_reused');
      throw error;
    }
  }

  @Get('history')
  @AllMembers()
  async history(
    @Req() request: AuthedRequest,
    @Query('invoiceNumber') invoiceNumber: string | undefined,
  ): Promise<ReminderHistoryResponse> {
    if (!invoiceNumber || invoiceNumber.length > 40) throw new BadRequestException('invoiceNumber');
    try {
      return await this.reminders.history(request.auth!.businessId, invoiceNumber);
    } catch (error) {
      if (error instanceof ReminderInvoiceNotFound)
        throw new NotFoundException('invoice_not_found');
      throw error;
    }
  }

  /** The "stop reminders for this invoice" control, and its undo. */
  @Post('stop')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async stop(@Req() request: AuthedRequest, @Body() body: unknown): Promise<{ stopped: boolean }> {
    const parsed = stopRemindersRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('invoiceNumber and stopped');
    try {
      await this.reminders.setStopped(
        request.auth!.businessId,
        parsed.data.invoiceNumber,
        parsed.data.stopped,
      );
    } catch (error) {
      if (error instanceof ReminderInvoiceNotFound)
        throw new NotFoundException('invoice_not_found');
      throw error;
    }
    return { stopped: parsed.data.stopped };
  }

  /** The business phone a reminder shows to the customer. Owner only: it is the merchant's public face. */
  @Put('public-contact')
  @Roles('owner')
  async publicContact(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ saved: true }> {
    const parsed = publicContactRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('phone');
    if (!(await this.reminders.setPublicContact(request.auth!.businessId, parsed.data.phone))) {
      throw new BadRequestException('invalid_phone');
    }
    return { saved: true };
  }

  /** The bank details a reminder asks customers to pay into. Owner and delegate may read them. */
  @Get('payment-instruction')
  @Roles('owner', 'delegate')
  async paymentInstruction(@Req() request: AuthedRequest): Promise<PaymentInstructionResponse> {
    return this.reminders.paymentInstruction(request.auth!.businessId);
  }

  /**
   * Saving is the owner approving this destination for reminders (`approve: true` is required by
   * the contract). Only the owner: it decides where customers send money.
   */
  @Put('payment-instruction')
  @Roles('owner')
  async setPaymentInstruction(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<PaymentInstructionResponse> {
    const parsed = paymentInstructionRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('payment_instruction_and_approval_required');
    const result = await this.reminders.setPaymentInstruction(
      request.auth!.businessId,
      request.auth!.userId,
      parsed.data,
    );
    if (!result.ok)
      throw new BadRequestException({
        error: 'invalid_payment_instruction',
        issues: result.issues,
      });
    return this.reminders.paymentInstruction(request.auth!.businessId);
  }

  @Delete('payment-instruction')
  @Roles('owner')
  @HttpCode(200)
  async clearPaymentInstruction(
    @Req() request: AuthedRequest,
  ): Promise<PaymentInstructionResponse> {
    await this.reminders.clearPaymentInstruction(request.auth!.businessId);
    return { instruction: null };
  }
}

/**
 * The opt-out's own per-IP limit (REM-02), tighter than the global one in `main.ts`. A customer
 * clicks the link once or twice; anything faster is someone guessing at tokens. It is the global
 * plugin's route config, so it keeps the global key (the visitor, not the hop), allow list and
 * error body, and replaces the global ceiling on this route only.
 */
export const REMINDER_OPT_OUT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/** Public: a customer following the link in a reminder email. No session; the signed token is the proof. */
@Controller('v1/public/reminders')
export class PublicReminderOptOutController {
  constructor(@Inject(ReminderService) private readonly reminders: ReminderService) {}

  @Post('opt-out')
  @HttpCode(200)
  @RouteConfig({ rateLimit: REMINDER_OPT_OUT_RATE_LIMIT })
  async optOut(@Body() body: unknown): Promise<{ optedOut: true }> {
    const parsed = reminderOptOutRequest.safeParse(body);
    /* One answer for a bad, forged or foreign token, so the route cannot be used to probe. */
    if (!parsed.success || !(await this.reminders.optOut(parsed.data.token))) {
      throw new NotFoundException('link_not_valid');
    }
    return { optedOut: true };
  }
}
