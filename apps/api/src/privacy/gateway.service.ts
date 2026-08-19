import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  generateCustomerToken,
  sequentialToken,
  tokeniseMessage,
  type PiiSpan,
  type TokenisedMessage,
} from '@rekoda/core/privacy';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { customersRepo, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';

/**
 * The privacy gateway's call site (MASTER-PLAN §5.3.2, ADR 0005).
 *
 * `@rekoda/core/privacy` knows how to find identities in a sentence;
 * `@rekoda/core/vault` knows how to encrypt one. Neither has a database, on
 * purpose. This is the seam where they meet one, and the only place in the
 * application that turns a merchant's words into something a model may see.
 *
 * Traffic here is one-way. Nothing in this file rehydrates.
 */
@Injectable()
export class PrivacyGateway {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Turn a raw message into AI-safe text.
   *
   * Phones and emails identify a *person*, so they resolve to a stable
   * `CUSTOMER_x` token: the same number next month yields the same token,
   * which is how a customer stays one customer across a year of messages
   * without her number ever leaving the vault.
   *
   * Account numbers do not. They get a per-message `ACCOUNT_1` token and are
   * **never stored** — not in the vault, not in the conversation, nowhere.
   * Rekoda has no reason to keep a bank account number a merchant happened to
   * type, and the cheapest way to protect one is not to hold it.
   */
  async tokenise(businessId: string, text: string): Promise<TokenisedMessage> {
    let accounts = 0;
    const pending: Array<{ kind: 'phone' | 'email'; value: string; placeholder: string }> = [];

    /**
     * `tokeniseMessage` is synchronous — it walks a string — while resolving a
     * customer is a database round trip. So the first pass assigns
     * placeholders and records what needs looking up, and a second pass
     * substitutes the real tokens. Making the core async to avoid the two
     * passes would put a database in the middle of a pure function.
     */
    const firstPass = tokeniseMessage(text, (kind: PiiSpan['kind'], value: string): string => {
      if (kind === 'account') return sequentialToken(kind, ++accounts);
      const placeholder = `PENDINGTOKEN${pending.length}X`;
      pending.push({ kind, value, placeholder });
      return placeholder;
    });

    let out = firstPass.text;
    const tokens = new Map<string, string>();
    const placeholders = new Set(pending.map((p) => p.placeholder));
    for (const [token, value] of firstPass.tokens) {
      if (!placeholders.has(token)) tokens.set(token, value);
    }

    for (const item of pending) {
      const token = await this.customerTokenFor(businessId, item.kind, item.value);
      out = out.split(item.placeholder).join(token);
      tokens.set(token, item.value);
    }

    return { text: out, tokens };
  }

  /**
   * The token for a person, creating them if this business has not seen them.
   *
   * The match key is a keyed HMAC that mixes in `businessId`, so the same
   * phone number produces a different key for every merchant — a dump reveals
   * nothing about which merchants share a customer.
   */
  private async customerTokenFor(
    businessId: string,
    facet: 'phone' | 'email',
    value: string,
  ): Promise<string> {
    const normalised = normaliseFacet(facet, value);
    const matchKey = matchKeyFor(businessId, facet, normalised, this.config.matchKey);

    const existing = await customersRepo.findCustomerByMatchKey(
      this.db,
      businessId,
      facet,
      matchKey,
    );
    if (existing) return existing.token;

    /**
     * Two failures are possible from here and they want opposite responses.
     *
     * A token collision means "this new customer drew a token somebody else
     * already has" — retry with a different one. An identity conflict means
     * another transaction created this very customer between our lookup and
     * our insert — the customer is not new any more, so look them up rather
     * than minting a second record for the same person.
     */
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = generateCustomerToken((n) => randomBytes(n));
      try {
        const created = await customersRepo.createCustomerWithIdentities(
          this.db,
          businessId,
          token,
          [{ facet, ciphertext: encryptFacet(value, this.config.vaultKey), matchKey }],
        );
        return created.token;
      } catch (error) {
        if (error instanceof customersRepo.IdentityConflict) {
          const winner = await customersRepo.findCustomerByMatchKey(
            this.db,
            businessId,
            facet,
            matchKey,
          );
          if (winner) return winner.token;
          continue;
        }
        if (!(error instanceof customersRepo.TokenCollision)) throw error;
      }
    }
    throw new Error('could not resolve a customer token in five attempts');
  }
}
