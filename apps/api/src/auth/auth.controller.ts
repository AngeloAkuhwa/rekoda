import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InvalidPhoneError } from '@rekoda/core/identity';
import {
  createBusinessRequest,
  requestOtpRequest,
  verifyOtpRequest,
  type MeResponse,
  type RequestOtpResponse,
  type SessionResponse,
  type SetupStateResponse,
  type VerifyOtpResponse,
} from '@rekoda/contracts';
import { AuthService, SetupTokenInvalid } from './auth.service.js';
import { SessionGuard, type AuthedRequest } from './session.guard.js';
import { Roles, RolesGuard } from './roles.guard.js';

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() body: unknown): Promise<RequestOtpResponse> {
    const parsed = requestOtpRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('phone is required');
    try {
      return await this.auth.requestOtp(parsed.data.phone);
    } catch (error) {
      if (error instanceof InvalidPhoneError) {
        throw new BadRequestException('not a Nigerian mobile number');
      }
      throw error;
    }
  }

  /**
   * Always 200, whatever the outcome.
   *
   * Status codes are a side channel: a 401 for a wrong code and a 404 for an
   * unknown number tells a prober which numbers have pending sign-ins. The
   * outcome is in the body, and every branch looks identical from outside.
   */
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown): Promise<VerifyOtpResponse> {
    const parsed = verifyOtpRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('phone and a 6-digit code are required');
    try {
      return await this.auth.verifyOtp(parsed.data.phone, parsed.data.code);
    } catch (error) {
      if (error instanceof InvalidPhoneError) {
        throw new BadRequestException('not a Nigerian mobile number');
      }
      throw error;
    }
  }

  @Delete('session')
  @HttpCode(204)
  async signOut(@Headers('authorization') header?: string): Promise<void> {
    if (header?.startsWith('Bearer ')) {
      await this.auth.revokeSession(header.slice('Bearer '.length));
    }
  }

  /**
   * Introspect a setup grant.
   *
   * `apps/web` cannot check the signature itself — only the API holds the
   * secret — so without this the business-setup step could only guard on "a
   * cookie is present", which is precisely the weak check that let a forged
   * value render the form.
   */
  @Get('setup')
  setupState(@Headers('x-rekoda-setup-token') setupToken?: string): SetupStateResponse {
    if (!setupToken) throw new UnauthorizedException('setup token required');
    const grant = this.auth.readSetupGrant(setupToken);
    if (!grant) throw new UnauthorizedException('setup token is missing, expired or forged');
    return { phone: grant.phone, expiresAt: grant.expiresAt.toISOString() };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() request: AuthedRequest): MeResponse {
    return request.auth!;
  }
}

@Controller('v1/businesses')
export class BusinessController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * Guarded by the setup grant rather than a session, because at this point
   * there is no business for a session to be bound to.
   */
  @Post()
  @HttpCode(201)
  async create(
    @Headers('x-rekoda-setup-token') setupToken: string | undefined,
    @Body() body: unknown,
  ): Promise<SessionResponse> {
    if (!setupToken) throw new UnauthorizedException('setup token required');

    const parsed = createBusinessRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('name and business type are required');

    try {
      return await this.auth.createFirstBusiness(setupToken, parsed.data);
    } catch (error) {
      if (error instanceof SetupTokenInvalid) throw new UnauthorizedException(error.message);
      throw error;
    }
  }

  /**
   * Exists to prove the role boundary is real (M1 exit criterion): an
   * accountant is inside the tenant and passes every RLS policy, so only the
   * guard keeps them out of settings.
   */
  @Post('settings')
  @HttpCode(200)
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('owner')
  updateSettings(@Req() request: AuthedRequest): { businessId: string } {
    return { businessId: request.auth!.businessId };
  }
}
