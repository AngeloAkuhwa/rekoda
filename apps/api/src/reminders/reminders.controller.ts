/**
 * Customer payment reminders (N1 slice A, OWN-43, OWN-57). Thin: the rules are in `@rekoda/core`
 * and the sequence in `ReminderService`. `businessId` comes from the session, never a body.
 *
 * Sending and stopping are for the owner and the delegate (day-to-day trade); an accountant reads.
 * The opt-out is the one public route: the signed token in the email is its only credential.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  publicContactRequest,
  reminderOptOutRequest,
  sendReminderRequest,
  stopRemindersRequest,
  type ReminderHistoryResponse,
  type SendReminderResponse,
} from '@rekoda/contracts';
import { AllMembers, Roles, RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { ReminderInvoiceNotFound, ReminderService } from './reminder.service.js';

@Controller('v1/reminders')
@UseGuards(SessionGuard, RolesGuard)
export class RemindersController {
  constructor(@Inject(ReminderService) private readonly reminders: ReminderService) {}

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
}

/** Public: a customer following the link in a reminder email. No session; the signed token is the proof. */
@Controller('v1/public/reminders')
export class PublicReminderOptOutController {
  constructor(@Inject(ReminderService) private readonly reminders: ReminderService) {}

  @Post('opt-out')
  @HttpCode(200)
  async optOut(@Body() body: unknown): Promise<{ optedOut: true }> {
    const parsed = reminderOptOutRequest.safeParse(body);
    /* One answer for a bad, forged or foreign token, so the route cannot be used to probe. */
    if (!parsed.success || !(await this.reminders.optOut(parsed.data.token))) {
      throw new NotFoundException('link_not_valid');
    }
    return { optedOut: true };
  }
}
