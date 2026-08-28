/**
 * The v1 public surface (canonical spec §27).
 *
 * `/api/v1`, deliberately its own namespace rather than another prefix on
 * `/v1`: the dashboard's routes and the public API's routes have different
 * clients, different credentials and different rates of change, and a URL
 * that says which one you are talking to is the cheapest possible version
 * boundary. The version segment is the version — no header negotiation, no
 * content-type stunts, nothing a proxy can strip.
 *
 * One route today. What matters is that every route added here answers in
 * the shapes `@rekoda/contracts` publicApi.v1 exports, and fails in the
 * envelope the filter enforces, so PR-111's Merchant API inherits both
 * without deciding either.
 */
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { publicApi } from '@rekoda/contracts';
import { ApiKeyGuard, type ApiKeyedRequest } from '../api-key.guard.js';
import { ApiKeysService } from '../api-keys.service.js';
import { PublicApiExceptionFilter } from './public-api.filter.js';

@Controller('api/v1')
@UseGuards(ApiKeyGuard)
@UseFilters(PublicApiExceptionFilter)
export class PublicV1Controller {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get('identity')
  async identity(@Req() request: ApiKeyedRequest): Promise<publicApi.v1.PublicIdentityResponse> {
    const caller = request.api!;
    const businessName = await this.keys.businessName(caller.businessId);
    /* A key whose business has since gone is not a 500. It is a credential
     * pointing at nothing, and the honest answer is that it resolves to no
     * business rather than an internal error the caller cannot act on. */
    if (!businessName) throw new NotFoundException('this key points at no business');

    return publicApi.v1.publicIdentityResponse.parse({
      businessId: caller.businessId,
      businessName,
      applicationId: caller.applicationId,
      keyPrefix: caller.keyPrefix,
      mode: caller.mode,
      rateLimitPerMinute: caller.rateLimitPerMinute,
    });
  }
}
