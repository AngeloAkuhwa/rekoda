/**
 * Where a merchant registers an integration and mints its credentials
 * (canonical spec §27).
 *
 * Behind an ordinary session, and owner only. Minting an API key is handing
 * out standing access to the books that survives every sign-out, so it sits
 * beside the other things only an owner may do rather than beside the things
 * a delegate does daily.
 *
 * Note what this controller is NOT: it is not the public API. It is the
 * dashboard surface that issues the public API's keys, which is why it
 * answers to a session and lives under `/v1/api-keys` rather than under the
 * versioned public namespace PR-110 opens.
 */
import {
  BadRequestException,
  Body,
  ForbiddenException,
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
  apiApplicationListResponse,
  createApiApplicationRequest,
  createApiKeyRequest,
  createApiKeyResponse,
  type ApiApplicationListResponse,
  type ApiApplicationView,
  type CreateApiKeyResponse,
} from '@rekoda/contracts';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { ApiKeysService } from './api-keys.service.js';

@Controller('v1/api-keys')
@UseGuards(SessionGuard, RolesGuard)
@Roles('owner')
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get()
  async list(@Req() request: AuthedRequest): Promise<ApiApplicationListResponse> {
    const { applications, keys } = await this.keys.listApplications(request.auth!.businessId);
    return apiApplicationListResponse.parse({ applications, keys });
  }

  @Post('applications')
  @HttpCode(200)
  async register(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ApiApplicationView> {
    const parsed = createApiApplicationRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a name for the application');

    const created = await this.keys.registerApplication(request.auth!.businessId, parsed.data.name);
    if ('reason' in created) {
      /* The dashboard's own refusal, not the public envelope: this surface
       * answers a session, and the merchant reading it needs the sentence
       * they can act on rather than a machine code. */
      throw new ForbiddenException(
        'this business has no API applications left this month, buy more capacity first',
      );
    }
    return created;
  }

  @Post('applications/:id/keys')
  @HttpCode(200)
  async mint(
    @Req() request: AuthedRequest,
    @Param('id') applicationId: string,
    @Body() body: unknown,
  ): Promise<CreateApiKeyResponse> {
    const parsed = createApiKeyRequest.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException('a label, or nothing at all');

    const outcome = await this.keys.mintKey(request.auth!.businessId, applicationId, {
      label: parsed.data.label ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    });

    if ('reason' in outcome) {
      switch (outcome.reason) {
        case 'unknown_application':
          throw new NotFoundException('no such application');
        case 'application_disabled':
          throw new BadRequestException('this application is disabled, enable it first');
        case 'too_many_keys':
          throw new BadRequestException(
            `this application already holds ${outcome.limit} live keys, revoke one first`,
          );
      }
    }

    /* Parsed on the way out as well as in. The token is in this body and
     * nowhere else, so the shape that carries it is worth validating. */
    return createApiKeyResponse.parse(outcome);
  }

  @Post('keys/:id/revoke')
  @HttpCode(200)
  async revoke(
    @Req() request: AuthedRequest,
    @Param('id') keyId: string,
  ): Promise<{ revoked: true }> {
    const done = await this.keys.revokeKey(request.auth!.businessId, keyId);
    if (!done) throw new NotFoundException('no such key');
    return { revoked: true };
  }

  @Post('applications/:id/disable')
  @HttpCode(200)
  async disable(
    @Req() request: AuthedRequest,
    @Param('id') applicationId: string,
  ): Promise<{ status: 'disabled' }> {
    const done = await this.keys.setApplicationStatus(
      request.auth!.businessId,
      applicationId,
      'disabled',
    );
    if (!done) throw new NotFoundException('no such application');
    return { status: 'disabled' };
  }

  @Post('applications/:id/enable')
  @HttpCode(200)
  async enable(
    @Req() request: AuthedRequest,
    @Param('id') applicationId: string,
  ): Promise<{ status: 'active' }> {
    const done = await this.keys.setApplicationStatus(
      request.auth!.businessId,
      applicationId,
      'active',
    );
    if (!done) throw new NotFoundException('no such application');
    return { status: 'active' };
  }
}
