import { seatsFor } from '@rekoda/core';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Delete,
  Get,
  Headers,
  HttpCode,
  ConflictException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { usageRepo, billingRepo, identity, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { InvalidPhoneError, normalisePhone } from '@rekoda/core/identity';
import {
  createBusinessRequest,
  inviteMemberRequest,
  magicRedeemRequest,
  requestOtpRequest,
  setPlanRequest,
  verifyOtpRequest,
  type MagicRedeemResponse,
  type MeResponse,
  type RequestOtpResponse,
  type SessionResponse,
  type SetupStateResponse,
  type TeamMember,
  type TeamResponse,
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
   * Exchange a tapped sign-in link for a session.
   *
   * Rate-limited by the same per-IP budget as every other auth route, and
   * deliberately indistinguishable in its failures: expired, already used and
   * never existed all answer the same way, because telling them apart would
   * tell whoever is guessing which of the three they achieved.
   */
  @Post('magic/redeem')
  @HttpCode(200)
  async redeemMagicLink(@Body() body: unknown): Promise<MagicRedeemResponse> {
    const parsed = magicRedeemRequest.safeParse(body);
    if (!parsed.success) return { status: 'invalid' };

    const session = await this.auth.redeemDashboardLink(parsed.data.token);
    return session ? { status: 'signed_in', ...session } : { status: 'invalid' };
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
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

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

  /**
   * Who can see this business's books.
   *
   * Owner only, and by the same reasoning the settings endpoint exists for:
   * an accountant is INSIDE the tenant and passes every row-level security
   * policy, so the guard is the only thing between them and the ability to
   * add somebody else.
   */
  @Get('members')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('owner')
  async members(@Req() request: AuthedRequest): Promise<TeamResponse> {
    const businessId = request.auth!.businessId;
    const members = await withBusiness(this.db, businessId, (tx) =>
      identity.membersOf(tx, businessId),
    );
    return { members: members.map(toWire) };
  }

  /**
   * Invite an accountant, by phone.
   *
   * The role has been enforced since M1 and nobody could ever become one,
   * which made the guard a fence around an empty field. The invitee needs no
   * Rekoda account first: their user row is created here and the OTP flow
   * finds it when they sign in on their own phone.
   */
  @Post('members')
  @HttpCode(201)
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('owner')
  async invite(@Req() request: AuthedRequest, @Body() body: unknown): Promise<TeamMember> {
    const parsed = inviteMemberRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('phone and role are required');

    let phone: string;
    try {
      phone = normalisePhone(parsed.data.phone);
    } catch {
      throw new BadRequestException('that does not look like a Nigerian phone number');
    }

    const businessId = request.auth!.businessId;
    /* The plan's seat table, from the same core table the pricing page
     * quotes. Enforced here and not in the repo's SQL, so the refusal can
     * name the plan and the way out. */
    const plan = await withBusiness(this.db, businessId, (tx) => usageRepo.planFor(tx, businessId));
    const seatLimit = seatsFor(plan);

    try {
      return toWire(
        await identity.inviteMember(this.db, businessId, phone, parsed.data.role, seatLimit),
      );
    } catch (error) {
      if (error instanceof identity.AlreadyAMember) {
        /* The merchant-grade sentence, here at the source: the form shows
         * whatever this says, and "already a accountant of this business"
         * is a log line, not an answer. */
        throw new ConflictException('That number already has access to this business.');
      }
      if (error instanceof identity.SeatLimitReached) {
        throw new ConflictException(
          plan === 'expired'
            ? 'Your subscription has ended, so the team cannot grow. Renew to add people.'
            : `Your plan includes ${error.limit} team member${error.limit === 1 ? '' : 's'} besides you. Upgrade to add more.`,
        );
      }
      throw error;
    }
  }

  /** Take access away. The owner cannot be removed, by anybody. */
  @Delete('members/:userId')
  @HttpCode(200)
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('owner')
  async removeMember(
    @Req() request: AuthedRequest,
    @Param('userId') userId: string,
  ): Promise<{ removed: boolean }> {
    const businessId = request.auth!.businessId;
    try {
      const removed = await withBusiness(this.db, businessId, (tx) =>
        identity.removeMember(tx, businessId, userId),
      );
      return { removed };
    } catch (error) {
      if (error instanceof identity.CannotRemoveOwner) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Move a business onto a plan. An OPERATOR action, not a merchant one:
   * an owner who could set their own plan could award themselves Complete
   * for free, so this is gated on the deployment secret rather than on any
   * session, and the acting operator is named in the audit trail.
   *
   * This is the smallest thing that stops a paying merchant being stuck on
   * trial allowances. Self-service purchase (M4) replaces the caller, not
   * the audit row.
   */
  @Post('plan')
  @HttpCode(200)
  async setPlan(
    @Headers('x-rekoda-operator-secret') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ plan: string }> {
    const expected = this.config.operatorSecret;
    if (!expected || !secret || !matchesSecret(secret, expected)) {
      throw new ForbiddenException('operator secret required');
    }

    const parsed = setPlanRequest.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('businessId, plan, expiresAt and actor are required');
    }

    const { businessId, plan, expiresAt, actor } = parsed.data;
    const changed = await billingRepo.setPlan(this.db, {
      businessId,
      plan,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      actor: `operator:${actor}`,
    });
    if (!changed) throw new NotFoundException('no business with that id');
    return { plan };
  }
}

/**
 * Constant-time secret comparison with no length oracle.
 *
 * Comparing digests rather than the strings means the observable work is
 * identical whatever the caller sent: a raw length pre-check answered
 * faster for wrong-length guesses, which quietly told an attacker how long
 * the secret is. Hashing first costs microseconds and says nothing.
 */
function matchesSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** A member as the wire sees one. Phone included: it is the only handle an
 * owner has for a person they invited, and it is their own team. */
function toWire(member: identity.TeamMember): TeamMember {
  return {
    userId: member.userId,
    phone: member.phone,
    role: member.role,
    addedAt: member.addedAt.toISOString(),
  };
}
