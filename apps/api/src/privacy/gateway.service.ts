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
/** One facet resolved to a customer, and whether that customer is brand new. */
interface ResolvedCustomer {
  token: string;
  customerId: string;
  facet: 'phone' | 'email' | 'name';
  created: boolean;
}

/**
 * Two records this message may have made out of one person.
 *
 * A PROPOSAL and never an action. The merchant is asked in the preview they
 * are already reading, and their `yes` covers the sale and the link together.
 */
export interface IdentityLinkProposal {
  /** The record that survives, and the token the command will name. */
  survivorId: string;
  survivorToken: string;
  /** The record created moments ago, whose facet moves across. */
  orphanId: string;
  orphanToken: string;
}

export interface GatewayTokenised extends TokenisedMessage {
  /** Null on almost every message. */
  readonly link: IdentityLinkProposal | null;
}

/**
 * Decide whether this message split one person in two.
 *
 * Only when exactly two customers were referenced and at least one of them was
 * CREATED here. Two records the merchant has been using for weeks are a
 * different question with different consequences, and joining those should
 * not ride on a sale preview. Three or more is not a link, it is a sentence
 * about several people.
 *
 * The survivor is the one that already existed; when both are new, the
 * phone-keyed record wins, because a phone is the identity anchor everywhere
 * else in this system and a merchant reaches a customer on it.
 */
function proposeLink(seen: ResolvedCustomer[]): IdentityLinkProposal | null {
  if (seen.length !== 2) return null;
  const [a, b] = seen as [ResolvedCustomer, ResolvedCustomer];
  if (!a.created && !b.created) return null;

  const survivor = !a.created ? a : !b.created ? b : a.facet === 'phone' ? a : b;
  const orphan = survivor === a ? b : a;
  /* Both existing was excluded above, so an orphan that is not new means the
   * survivor is the new one, and the two are the wrong way round. */
  if (!orphan.created) return null;

  return {
    survivorId: survivor.customerId,
    survivorToken: survivor.token,
    orphanId: orphan.customerId,
    orphanToken: orphan.token,
  };
}

/** Names shorter than this match too much prose to be safe to substitute. */
const MIN_NAME_LENGTH = 3;

/**
 * The longest run of words the known-name pass will treat as one name.
 *
 * The message is scanned as overlapping word-groups of one to this many
 * words, and each group is hashed and looked up. Six covers a long Nigerian
 * name with titles ("Alhaji Ibrahim Musa Abubakar Sani") while keeping the
 * candidate count linear in the message length.
 */
const MAX_NAME_WORDS = 6;

/**
 * A word for the purpose of name-matching: letters or digits, with an inner
 * apostrophe or hyphen kept ("O'Neil", "Adaeze-Ann") so a hyphenated name is
 * one word rather than two.
 */
const NAME_WORD = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;

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
  async tokenise(businessId: string, text: string): Promise<GatewayTokenised> {
    let accounts = 0;
    const pending: Array<{ kind: 'phone' | 'email'; value: string; placeholder: string }> = [];
    const seen: ResolvedCustomer[] = [];

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
      const resolved = await this.customerTokenFor(businessId, item.kind, item.value);
      out = out.split(item.placeholder).join(resolved.token);
      tokens.set(resolved.token, item.value);
      if (!seen.some((c) => c.customerId === resolved.customerId)) seen.push(resolved);
    }

    /**
     * The known-name pass. Structure finds phones and emails; it cannot find
     * "Ada Obi". But once a name has entered the vault (a confirmed sale, a
     * mention resolved below), it is a stored identity like any other, and a
     * message naming that customer must not carry the name to a model.
     *
     * The match is by keyed hash, not by decrypting names. Every run of one
     * to MAX_NAME_WORDS words in the message is folded and hashed the same
     * way a stored name was, and the whole set is looked up in one query. So
     * the pass is complete for any customer count and costs the message's
     * length, not the customer table: it never reads a name that was not
     * typed, and there is no cap above which a real customer stops being
     * recognised.
     */
    const words = [...out.matchAll(NAME_WORD)].map((m) => {
      const start = m.index ?? 0;
      return { start, end: start + m[0].length };
    });
    const candidates: Array<{ start: number; end: number; matchKey: string }> = [];
    const keys = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      const from = words[i];
      if (!from) continue;
      for (let n = 1; n <= MAX_NAME_WORDS && i + n <= words.length; n++) {
        const to = words[i + n - 1];
        if (!to) continue;
        const start = from.start;
        const end = to.end;
        const normalised = normaliseFacet('name', out.slice(start, end));
        if (normalised.length < MIN_NAME_LENGTH) continue;
        const matchKey = matchKeyFor(businessId, 'name', normalised, this.config.matchKey);
        candidates.push({ start, end, matchKey });
        keys.add(matchKey);
      }
    }

    const found = await customersRepo.namesByMatchKeys(this.db, businessId, [...keys]);
    const byKey = new Map<string, { token: string; customerId: string }>();
    for (const row of found) {
      if (!byKey.has(row.matchKey)) byKey.set(row.matchKey, row);
    }

    /* Longest span first so "Ada Obi Junior" beats "Ada Obi", then leftmost;
     * an already-claimed span blocks any overlap, so a name is tokenised once
     * and its words are never re-consumed by a shorter match. */
    const hits = candidates
      .filter((c) => byKey.has(c.matchKey))
      .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const claimed: Array<{ start: number; end: number; token: string; customerId: string }> = [];
    for (const hit of hits) {
      if (claimed.some((c) => hit.start < c.end && c.start < hit.end)) continue;
      const match = byKey.get(hit.matchKey);
      if (!match) continue;
      claimed.push({
        start: hit.start,
        end: hit.end,
        token: match.token,
        customerId: match.customerId,
      });
    }

    /* Rewrite right to left so an earlier span's offsets survive a later
     * substitution that changes the string's length. */
    for (const c of [...claimed].sort((a, b) => b.start - a.start)) {
      tokens.set(c.token, out.slice(c.start, c.end));
      out = out.slice(0, c.start) + c.token + out.slice(c.end);
      if (!seen.some((s) => s.customerId === c.customerId)) {
        seen.push({ token: c.token, customerId: c.customerId, facet: 'name', created: false });
      }
    }

    return { text: out, tokens, link: proposeLink(seen) };
  }

  /**
   * A NAME the model reported, turned into the customer it belongs to.
   *
   * Called when a command arrives with `{kind: 'mention'}`: the first time a
   * merchant sells to "Ada Obi", the name reaches the model (nothing knew it
   * yet), the model hands it back here, and from this moment the name is a
   * vault identity with a token. The draft stores the token, the preview
   * shows the token, and the next message that types this name never reaches
   * a model carrying it. This is the minimisation layer the structural pass
   * defers to.
   */
  async resolveMention(
    businessId: string,
    mention: string,
  ): Promise<{ token: string; customerId: string }> {
    const resolved = await this.customerTokenFor(businessId, 'name', mention);
    return { token: resolved.token, customerId: resolved.customerId };
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
    facet: 'phone' | 'email' | 'name',
    value: string,
  ): Promise<ResolvedCustomer> {
    const normalised = normaliseFacet(facet, value);
    const matchKey = matchKeyFor(businessId, facet, normalised, this.config.matchKey);

    const existing = await customersRepo.findCustomerByMatchKey(
      this.db,
      businessId,
      facet,
      matchKey,
    );
    if (existing) {
      return { token: existing.token, customerId: existing.id, facet, created: false };
    }

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
          [
            {
              facet,
              ciphertext: encryptFacet(value, this.config.vaultKey, `${businessId}:${facet}`),
              matchKey,
            },
          ],
        );
        return { token: created.token, customerId: created.id, facet, created: true };
      } catch (error) {
        if (error instanceof customersRepo.IdentityConflict) {
          const winner = await customersRepo.findCustomerByMatchKey(
            this.db,
            businessId,
            facet,
            matchKey,
          );
          if (winner) {
            return { token: winner.token, customerId: winner.id, facet, created: false };
          }
          continue;
        }
        if (!(error instanceof customersRepo.TokenCollision)) throw error;
      }
    }
    throw new Error('could not resolve a customer token in five attempts');
  }
}
