/**
 * The public API's front door (canonical spec §27).
 *
 * The counterpart of `SessionGuard`, and it keeps that guard's one
 * non-negotiable rule: `businessId` comes from the CREDENTIAL, never from a
 * body, a query or a header the caller controls. A public API is the surface
 * where a caller-supplied tenant id would be most convenient and most fatal.
 *
 * What the caller is told is deliberately thinner than what the service
 * knows. Unknown, revoked, expired and malformed all answer the same 401:
 * distinguishing them tells whoever is guessing which of the four they
 * achieved, and a revoked key confirmed as "revoked, not unknown" confirms
 * the key was real.
 */
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ApiKeysService, type ApiCaller } from './api-keys.service.js';
import { NotEntitledException } from './public/public-api.filter.js';

export interface ApiKeyedRequest {
  headers: Record<string, string | string[] | undefined>;
  api?: ApiCaller;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyedRequest>();
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('no api key');

    const result = await this.keys.authenticate(value.slice('Bearer '.length));
    if (result.ok) {
      request.api = result.caller;
      return true;
    }

    switch (result.failure.reason) {
      case 'not_entitled':
        /* The one refusal worth naming. It is not a guess a prober can turn
         * into anything — they already hold a working key — and the merchant
         * reading their integration's logs needs to know the answer is
         * "buy the API", not "your key is broken". */
        throw new NotEntitledException('this business does not have the Rekoda API entitlement');
      case 'rate_limited':
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'rate limit exceeded',
            retryAfterSeconds: result.failure.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      default:
        throw new UnauthorizedException('api key is not usable');
    }
  }
}
