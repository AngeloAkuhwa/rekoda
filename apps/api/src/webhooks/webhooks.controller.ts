/**
 * Where a merchant registers a callback (canonical spec §26, §27).
 *
 * Owner only, behind an ordinary session, for the same reason API keys are:
 * a webhook endpoint is a standing copy of the business's financial facts
 * going somewhere the owner chose, and it keeps working after every sign-out.
 *
 * This is not the public API. It is the dashboard surface that configures
 * what the public API's other half SENDS, which is why it answers to a
 * session and lives under `/v1/webhooks`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createWebhookEndpointRequest,
  webhookListResponse,
  webhookSecretResponse,
  type WebhookListResponse,
  type WebhookSecretResponse,
} from '@rekoda/contracts';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { WebhookDestinationRefused } from './destination.js';
import { WebhooksService } from './webhooks.service.js';

@Controller('v1/webhooks')
@UseGuards(SessionGuard, RolesGuard)
@Roles('owner')
export class WebhooksController {
  constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

  @Get()
  async list(@Req() request: AuthedRequest): Promise<WebhookListResponse> {
    return webhookListResponse.parse(await this.webhooks.list(request.auth!.businessId));
  }

  @Post()
  @HttpCode(200)
  async register(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<WebhookSecretResponse> {
    const parsed = createWebhookEndpointRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('an https URL, and optionally a name');

    let created: WebhookSecretResponse;
    try {
      created = await this.webhooks.register(request.auth!.businessId, {
        url: parsed.data.url,
        description: parsed.data.description ?? null,
        eventTypes: parsed.data.eventTypes ?? [],
      });
    } catch (error) {
      /* A refused destination or a full endpoint list is the merchant's to
       * fix, so it answers 400 with the reason rather than 500. The reason
       * never names an address (destination.ts). */
      if (error instanceof WebhookDestinationRefused) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    /* Parsed on the way out: this body carries the signing secret and is
     * the only place it ever appears. */
    return webhookSecretResponse.parse(created);
  }

  @Post(':id/rotate')
  @HttpCode(200)
  async rotate(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<WebhookSecretResponse> {
    const rotated = await this.webhooks.rotate(request.auth!.businessId, id);
    if (!rotated) throw new NotFoundException('no such endpoint');
    return webhookSecretResponse.parse(rotated);
  }

  @Post(':id/disable')
  @HttpCode(200)
  async disable(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ status: 'disabled' }> {
    const done = await this.webhooks.setStatus(request.auth!.businessId, id, 'disabled');
    if (!done) throw new NotFoundException('no such endpoint');
    return { status: 'disabled' };
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enable(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ status: 'active' }> {
    const done = await this.webhooks.setStatus(request.auth!.businessId, id, 'active');
    if (!done) throw new NotFoundException('no such endpoint');
    return { status: 'active' };
  }
}
