/**
 * The public API's first route (canonical spec §27).
 *
 * One endpoint, deliberately: it proves the whole chain — a key
 * authenticates, resolves a tenant, passes the entitlement gate and spends
 * rate-limit room — before PR-111 puts anything worth stealing behind it. A
 * developer integrating tomorrow calls this first, and a key pasted into the
 * wrong environment says so here rather than in a write to the wrong books.
 *
 * `/v1/api` rather than the versioned public namespace: the contract layer
 * and its version policy are PR-110's subject, and pre-empting them with a
 * URL shape would be deciding that PR in this one.
 */
import { Controller, Get, Inject, NotFoundException, Req, UseGuards } from '@nestjs/common';
import { apiIdentityResponse, type ApiIdentityResponse } from '@rekoda/contracts';
import { ApiKeyGuard, type ApiKeyedRequest } from './api-key.guard.js';
import { ApiKeysService } from './api-keys.service.js';

@Controller('v1/api')
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get('identity')
  async identity(@Req() request: ApiKeyedRequest): Promise<ApiIdentityResponse> {
    const caller = request.api!;
    const businessName = await this.keys.businessName(caller.businessId);
    /* A key whose business has since gone is not a 500. It is a credential
     * pointing at nothing, and the honest answer is that it resolves to no
     * business rather than an internal error the caller cannot act on. */
    if (!businessName) throw new NotFoundException('this key points at no business');

    return apiIdentityResponse.parse({
      businessId: caller.businessId,
      businessName,
      applicationId: caller.applicationId,
      keyPrefix: caller.keyPrefix,
      rateLimitPerMinute: caller.rateLimitPerMinute,
    });
  }
}
