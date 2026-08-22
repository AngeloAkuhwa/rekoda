/**
 * The bank's half of a reconciliation.
 *
 * Its own surface rather than another few methods on the reports controller,
 * because it answers a different question. Reports say what Rekoda's books
 * believe; this says what a merchant's bank says happened, and the value of
 * holding both is that they sometimes disagree.
 *
 * Thin, like the reports controller: the parsing is pure and lives in
 * @rekoda/core, the storage is one repo call, and `businessId` comes from the
 * session and never from a body.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { parseBankStatement } from '@rekoda/core';
import {
  bankPositionResponse,
  forgetStatementDayRequest,
  importStatementRequest,
  type BankPositionResponse,
  type ForgetStatementDayResponse,
  type ImportStatementResponse,
  type ReconcileResponse,
} from '@rekoda/contracts';
import { bankRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DB } from '../db/db.module.js';

@Controller('v1/bank')
@UseGuards(SessionGuard)
export class BankController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** What the books say against what the bank says, and the lines behind it. */
  @Get('position')
  async position(@Req() request: AuthedRequest): Promise<BankPositionResponse> {
    const businessId = request.auth!.businessId;
    const { position, lines, reconciliation } = await withBusiness(
      this.db,
      businessId,
      async (tx) => ({
        position: await bankRepo.bankPositionFor(tx, businessId),
        lines: await bankRepo.bankLinesFor(tx, businessId),
        /* Read without committing. Opening a page must not decide anything,
         * and pairing is a decision the merchant asks for. */
        reconciliation: await bankRepo.reconcile(tx, { businessId, commit: false }),
      }),
    );
    /* Parsed on the way out as well as on the way in. The narration is the
     * one field here that carries somebody's name, and the contract is the
     * border that says which fields may cross at all. */
    return bankPositionResponse.parse({ position, lines, reconciliation });
  }

  /**
   * Read a statement and keep what it said.
   *
   * The file arrives as text: the web tier already has the bytes when a
   * merchant picks a file, so converting them there keeps this a JSON
   * surface with no multipart parser and no temporary files.
   *
   * A file that cannot be read is an outcome rather than a 400. There are
   * six different ways a statement can be unreadable and the merchant needs
   * to be told which, not handed a status code.
   */
  @Post('statement')
  @HttpCode(200)
  async importStatement(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ImportStatementResponse> {
    const parsed = importStatementRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the statement file, as text');

    const statement = parseBankStatement(parsed.data.csv);
    if (!statement.ok) return { outcome: 'unreadable', reason: statement.reason };

    const businessId = request.auth!.businessId;
    const stored = await withBusiness(this.db, businessId, (tx) =>
      bankRepo.importStatementLines(tx, {
        businessId,
        lines: statement.lines,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    return {
      outcome: 'imported',
      imported: stored.imported,
      duplicates: stored.duplicates,
      skipped: statement.skipped.length,
    };
  }

  /**
   * Pair what can only be paired one way.
   *
   * A write, and asked for rather than done on a page load. The rule itself
   * is timid on purpose: exact amounts, a few days either side, and nothing
   * paired where two postings fit. A wrong match reports agreement between
   * books and bank that does not exist, which is the failure this whole
   * surface was built to catch.
   */
  @Post('reconcile')
  @HttpCode(200)
  async reconcile(@Req() request: AuthedRequest): Promise<ReconcileResponse> {
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: true }),
    );
  }

  /**
   * Take a day back out.
   *
   * A merchant who uploaded the wrong account's statement has to be able to
   * undo it, and there is no honest way to edit a line into being right: a
   * statement line is what the bank said.
   */
  @Post('statement/forget')
  @HttpCode(200)
  async forgetDay(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ForgetStatementDayResponse> {
    const parsed = forgetStatementDayRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the day to forget');

    const businessId = request.auth!.businessId;
    const removed = await withBusiness(this.db, businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, {
        businessId,
        postedOn: parsed.data.postedOn,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    return { removed };
  }
}
