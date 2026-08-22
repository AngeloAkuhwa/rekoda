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
  matchLineRequest,
  unmatchLineRequest,
  type MatchLineResponse,
  type UnmatchLineResponse,
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
    const { position, lines, reconciliation, openMovements, matches } = await withBusiness(
      this.db,
      businessId,
      async (tx) => {
        const statementLines = await bankRepo.bankLinesFor(tx, businessId);
        return {
          position: await bankRepo.bankPositionFor(tx, businessId),
          lines: statementLines,
          /* Read without committing. Opening a page must not decide anything,
           * and pairing is a decision the merchant asks for. */
          reconciliation: await bankRepo.reconcile(tx, { businessId, commit: false }),
          /* Only the amounts these lines could pair with. The page narrows
           * candidates to a line's exact amount, and asking for a page of
           * movements and filtering it left a merchant with no candidate at
           * all whenever the entry they wanted sat outside that page. */
          openMovements: await bankRepo.openMovements(tx, businessId, {
            amounts: statementLines.map((l) => l.amountK),
          }),
          matches: await bankRepo.matchesFor(tx, businessId),
        };
      },
    );
    const matchedBy = new Map(matches.map((m) => [m.lineId, m]));
    /* Parsed on the way out as well as on the way in. The narration is the
     * one field here that carries somebody's name, and the contract is the
     * border that says which fields may cross at all. */
    return bankPositionResponse.parse({
      position,
      reconciliation,
      openMovements,
      lines: lines.map((line) => {
        const match = matchedBy.get(line.id);
        return {
          ...line,
          matchedTo: match
            ? {
                transactionId: match.transactionId,
                memo: match.memo,
                decidedBy: match.decidedBy,
              }
            : null,
        };
      }),
    });
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
   * A merchant deciding what the rule would not.
   *
   * Two of the rule's conditions are lifted: which of two identical
   * transfers this one is, and how long ago it happened, are things a person
   * knows and a rule cannot. The amount is not lifted. Two figures a bank
   * charge apart are two facts, and the refusal says so rather than papering
   * over the charge inside a match.
   */
  @Post('match')
  @HttpCode(200)
  async match(@Req() request: AuthedRequest, @Body() body: unknown): Promise<MatchLineResponse> {
    const parsed = matchLineRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a line and an entry to pair it with');

    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      bankRepo.matchByHand(tx, {
        businessId,
        lineId: parsed.data.lineId,
        transactionId: parsed.data.transactionId,
        actor: `user:${request.auth!.userId}`,
      }),
    );
  }

  /**
   * Release a pairing.
   *
   * An automatic match on the wrong posting has to be undoable, or the rule's
   * timidity is the only protection a merchant has. Releasing changes neither
   * the line nor the posting: neither was ever altered by being matched.
   */
  @Post('unmatch')
  @HttpCode(200)
  async unmatch(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<UnmatchLineResponse> {
    const parsed = unmatchLineRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the line to release');

    const businessId = request.auth!.businessId;
    const released = await withBusiness(this.db, businessId, (tx) =>
      bankRepo.unmatchLine(tx, {
        businessId,
        lineId: parsed.data.lineId,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    return { released };
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
