import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CLITIC_SUFFIXES,
  detectStructuralPiiAroundTokens,
  displayOf,
  generateCustomerToken,
  openSegments,
  sequentialToken,
  tokeniseMessage,
  type PiiSpan,
  type TokenisedMessage,
  type TypedFacet,
} from '@rekoda/core/privacy';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { CUSTOMER_NAME_MAX_CHARS, CUSTOMER_NAME_MIN_CHARS } from '@rekoda/contracts';
import { customersRepo, suppliersRepo, withBusiness, type Db } from '@rekoda/db';
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
export interface ResolvedCustomer {
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
  /**
   * Every customer this message referenced, for a link that only a mention
   * resolved after tokenising can reveal (`linkAfterMention`). Ids and
   * tokens only, never an identity.
   */
  readonly customers: readonly ResolvedCustomer[];
  /**
   * Every facet the merchant typed for each customer token, which the display
   * in `tokens` was composed from (G-60). Authorised-layer only, like
   * `tokens`: never logged, stored or sent to a model.
   */
  readonly facets: ReadonlyMap<string, readonly TypedFacet[]>;
  /**
   * Why nothing the merchant typed is handed on, or null when the message
   * was read. `too_long`: the known-name pass could not finish
   * (KNOWN_NAME_CANDIDATE_LIMIT). `protected_detail`: the finished text still
   * holds a phone, email or account number, which only appears once a long
   * name became a short token (G-07). Either way `text` is UNREAD_MESSAGE.
   */
  readonly unread: UnreadReason | null;
}

export type UnreadReason = 'too_long' | 'protected_detail';

/**
 * The most distinct name candidates one message may raise (Codex on #271).
 * A long, varied 4 KB merchant message raises about 15,000; punctuation
 * crafted to differ around every word raises six times that. Past the
 * limit the pass stops, and a message it did not finish is never read.
 */
export const KNOWN_NAME_CANDIDATE_LIMIT = 40_000;

/** A customer token's characters after `CUSTOMER_` (generateCustomerToken's default). */
const CUSTOMER_TOKEN_SUFFIX = 3;

/** What stands for a message the gateway would not hand on, by reason. */
export const UNREAD_MESSAGE: Readonly<Record<UnreadReason, string>> = {
  too_long: '[message too long to read]',
  protected_detail: '[message not read: it held a protected detail]',
};

/** A message the gateway will not hand on: no text, no tokens, no link. */
function unreadAs(reason: UnreadReason): GatewayTokenised {
  return {
    text: UNREAD_MESSAGE[reason],
    tokens: new Map(),
    link: null,
    facets: new Map(),
    customers: [],
    unread: reason,
  };
}

/**
 * The token table one message carries to its reply: what each token reads
 * as, and the typed facets that reading was composed from.
 */
export interface LiveTokens {
  readonly displays: Map<string, string>;
  readonly facets: Map<string, TypedFacet[]>;
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

/**
 * A word for name-matching: letters with their combining marks (a Yoruba
 * tone mark never ends a word) and digits, an inner apostrophe or hyphen
 * kept, so "O'Neil", "Adaeze-Ann", "don't" and "Mary-Ann" are one word each
 * and never a shorter name (G-60).
 */
const NAME_WORD = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;

/**
 * The stems a word may also end at, a closed list shared with the stored-
 * message scrub (`CLITIC_SUFFIXES` in @rekoda/core/privacy): "Obi's",
 * "Ada'll", "Tunde'd" hold a name; "Ada-2" does too. "don't" does not.
 */
const CLITIC = new RegExp(`['’](?:${CLITIC_SUFFIXES.join('|')})$`, 'i');
const FIGURE_SUFFIX = /-\d+$/;

/** Punctuation a stored name may begin or end with: "Ada O.", "Mama Chidi (Ada)". */
const EDGE = /[^\s\p{L}\p{M}\p{N}]/u;

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

    /**
     * Every facet the merchant typed for each customer token, in the order
     * typed (G-60). One person named by phone AND name is one token, so the
     * model still sees one person; what the reply shows for that token is
     * composed from all of them once both passes are done, never from
     * whichever pass wrote last.
     */
    const typed = new Map<string, TypedFacet[]>();
    const note = (token: string, facet: TypedFacet['facet'], value: string) => {
      const list = typed.get(token) ?? [];
      list.push({ facet, value, key: normaliseFacet(facet, value) });
      typed.set(token, list);
    };

    /* Phones and emails are resolved to customers only once the message is
     * known to be readable (below): resolving one can create a customer and
     * vault its identity, and a message the gateway refuses must leave
     * nothing behind (G-07, Codex on #273). Until then each stands as its
     * placeholder, as opaque to the name pass as the token it becomes. */

    /**
     * The known-name pass. Structure finds phones and emails; it cannot find
     * "Ada Obi". But once a name has entered the vault (a confirmed sale, a
     * mention resolved below), it is a stored identity like any other, and a
     * message naming that customer must not carry the name to a model.
     *
     * The match is by keyed hash, not by decrypting names. Every run of words
     * whose folded form could be a stored name (at most
     * CUSTOMER_NAME_MAX_CHARS, the longest name any door stores) is hashed
     * the same way a stored name was and looked up. So every name the product
     * can store can be recognised, the pass is complete for any customer
     * count, and it costs the message's length, not the customer table.
     *
     * Tokens are opaque separators (G-60). The text BETWEEN tokens is scanned
     * segment by segment, so no candidate starts inside a token or runs across
     * one, and a name glued to a token ("Ada Obi-08031234567") is still a
     * name: the token ends the segment, it does not swallow the word.
     */
    /* A run as a name is measured: spacing folded, composed (NFC). */
    const composed = (run: string) => run.trim().replace(/\s+/g, ' ').normalize('NFC');
    const candidates: Array<{ start: number; end: number; matchKey: string }> = [];
    const keys = new Set<string>();
    const spans = new Set<string>();
    /* Each distinct candidate is hashed once per message, however many
     * places it stands (Codex on #271: bounded work for a crafted message). */
    const keysOf = new Map<string, string[]>();
    let unread = false;
    const consider = (start: number, end: number) => {
      if (spans.has(`${start}:${end}`)) return;
      spans.add(`${start}:${end}`);
      /* Bounded before folding case: lowercasing can lengthen a name ("İ"),
       * and the stored name was at most this long as typed. Measured
       * composed (NFC), the shortest form and the one a new name is keyed
       * in: a name within the limit composed can run past it decomposed
       * ("Ọ̀ṣúnbíyìí" typed on a decomposing keyboard) and is still a name.
       * A name holds a letter: a figure is never one ("10"). */
      const typedForm = composed(out.slice(start, end));
      if (typedForm.length > CUSTOMER_NAME_MAX_CHARS) return;
      if (typedForm.length < CUSTOMER_NAME_MIN_CHARS || !/\p{L}/u.test(typedForm)) return;
      const asTyped = out.slice(start, end).trim().replace(/\s+/g, ' ');
      let forms = keysOf.get(asTyped);
      if (!forms) {
        /* Fail closed: an unfinished pass could miss a stored name. */
        if (keysOf.size >= KNOWN_NAME_CANDIDATE_LIMIT) {
          unread = true;
          return;
        }
        forms = this.nameKeys(businessId, asTyped);
        keysOf.set(asTyped, forms);
      }
      for (const matchKey of forms) {
        candidates.push({ start, end, matchKey });
        keys.add(matchKey);
      }
    };
    scan: for (const segment of openSegments(out, [...tokens.keys(), ...placeholders])) {
      const words = [...out.slice(segment.start, segment.end).matchAll(NAME_WORD)].map((m) => {
        const start = segment.start + (m.index ?? 0);
        const end = start + m[0].length;
        const ends = [end];
        const clitic = m[0].search(CLITIC);
        if (clitic > 0) ends.push(start + clitic);
        const figure = m[0].search(FIGURE_SUFFIX);
        if (figure > 0) ends.push(start + figure);
        return { start, end, ends };
      });
      /* Every position across adjacent punctuation, not only the furthest:
       * "Ada O.," holds "Ada O." (G-60). Complete for every storable name and
       * bounded by it: a name is at most CUSTOMER_NAME_MAX_CHARS long, so no
       * candidate reaches further than that over punctuation either side. */
      /* Spaces between the punctuation and the word belong to the name too:
       * "( Ada )" is a storable name (Codex on #271). A candidate edge is
       * only ever a punctuation mark, never a space, and the walk counts
       * each run of spaces once, as the name itself folds them. */
      /* Each edge position with its reach: how much it adds to the name's
       * folded length (a mark 1, a run of spaces 1), so a span that cannot
       * fit a storable name is never built. */
      const walk = (at: number, step: -1 | 1, limit: number) => {
        const out_: Array<{ at: number; reach: number }> = [{ at, reach: 0 }];
        let reach = 0;
        let spaced = false;
        for (let p = at; p !== limit && reach < CUSTOMER_NAME_MAX_CHARS; p += step) {
          const ch = out[step < 0 ? p - 1 : p] ?? '';
          if (EDGE.test(ch)) {
            reach += 1;
            spaced = false;
            out_.push({ at: step < 0 ? p - 1 : p + 1, reach });
          } else if (/\s/.test(ch)) {
            if (!spaced) reach += 1;
            spaced = true;
          } else {
            break;
          }
        }
        return out_;
      };
      const walked = new Map<string, Array<{ at: number; reach: number }>>();
      const edges = (at: number, step: -1 | 1) => {
        const key = `${at}:${step}`;
        let found = walked.get(key);
        if (!found) {
          found = walk(at, step, step < 0 ? segment.start : segment.end);
          walked.set(key, found);
        }
        return found;
      };
      for (let i = 0; i < words.length; i++) {
        for (let j = i; j < words.length; j++) {
          const start = words[i]!.start;
          /* Linear: past the longest storable name, longer runs cannot match. */
          const shortest = Math.min(...words[j]!.ends);
          if (composed(out.slice(start, shortest)).length > CUSTOMER_NAME_MAX_CHARS) break;
          for (const end of words[j]!.ends) {
            /* The folded length is the lead's reach, the run, and the trail's
             * reach: exactly what `consider` measures, so pruning here loses
             * no storable name. */
            const run = composed(out.slice(start, end)).length;
            for (const s of edges(start, -1)) {
              if (s.reach + run > CUSTOMER_NAME_MAX_CHARS) break;
              for (const e of edges(end, 1)) {
                if (s.reach + run + e.reach > CUSTOMER_NAME_MAX_CHARS) break;
                consider(s.at, e.at);
                if (unread) break scan;
              }
            }
          }
        }
      }
    }

    if (unread) return unreadAs('too_long');

    const byKey = new Map<string, { token: string; customerId: string }>();
    /* One lookup per message, however many candidates (G-60). */
    for (const row of await customersRepo.namesByMatchKeys(this.db, businessId, [...keys])) {
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

    const names = [...claimed]
      .sort((a, b) => a.start - b.start)
      .map((c) => ({ ...c, typed: out.slice(c.start, c.end) }));
    /* Rewrite right to left so an earlier span's offsets survive a later
     * substitution that changes the string's length. */
    for (const c of [...claimed].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, c.start) + c.token + out.slice(c.end);
    }

    /* The contract is text free of structural PII, and the name pass can
     * break it: "send to Adaeze Obiageli Okonkwo 0123456789" holds no account
     * number until the long name becomes a short token within reach of the
     * keyword. Such text is never handed on, so it is never stored and no
     * model refuses it later (G-07). Read with every token as opaque
     * letters, each placeholder at the length of the token it becomes: a
     * token's digits neither hide the number ("CUSTOMER_X1A") nor make one
     * (Codex on #273). */
    const probe = out
      .split(/PENDINGTOKEN\d+X/)
      .join(`CUSTOMER_${'X'.repeat(CUSTOMER_TOKEN_SUFFIX)}`);
    const nameTokens = names.map((c) => c.token);
    if (detectStructuralPiiAroundTokens(probe, [...tokens.keys(), ...nameTokens]).length > 0) {
      return unreadAs('protected_detail');
    }

    for (const item of pending) {
      const resolved = await this.customerTokenFor(businessId, item.kind, item.value);
      out = out.split(item.placeholder).join(resolved.token);
      note(resolved.token, item.kind, item.value);
      if (!seen.some((c) => c.customerId === resolved.customerId)) seen.push(resolved);
    }
    for (const c of names) {
      note(c.token, 'name', c.typed);
      if (!seen.some((s) => s.customerId === c.customerId)) {
        seen.push({ token: c.token, customerId: c.customerId, facet: 'name', created: false });
      }
    }

    for (const [token, facets] of typed) tokens.set(token, displayOf(facets));
    return {
      text: out,
      tokens,
      link: proposeLink(seen),
      facets: typed,
      customers: seen,
      unread: null,
    };
  }

  /**
   * A name the model reported, resolved to `token`, added to what that token
   * reads as in the reply (G-60). Composed from the typed facets, never by
   * parsing a display: a phone the merchant typed and the name the model
   * resolved to the same customer read as one person, "Ada Obi (0803…)".
   */
  noteMention(live: LiveTokens, token: string, mention: string): void {
    const facets = live.facets.get(token) ?? [];
    facets.push({ facet: 'name', value: mention, key: normaliseFacet('name', mention) });
    live.facets.set(token, facets);
    live.displays.set(token, displayOf(facets));
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
  ): Promise<{ token: string; customerId: string; created: boolean }> {
    const resolved = await this.customerTokenFor(businessId, 'name', mention);
    return { token: resolved.token, customerId: resolved.customerId, created: resolved.created };
  }

  /**
   * Whether a name the model resolved AFTER tokenising split one person in
   * two (G-60 owner decision, 14 Oct 2026). A storefront buyer's name is
   * untrusted and never matches, so "Chidi Okafor 0803…" finds the phone
   * customer and the mention makes a new one beside it.
   *
   * The same rule as `proposeLink`, with the mention added to what the
   * message referenced: exactly two customers, at least one new, the one
   * that existed survives, and it is only ever a question. Only a NEW name
   * customer is an orphan here, and never onto a survivor that already has
   * a known name of its own: two trusted names would compete for one person.
   */
  async linkAfterMention(
    businessId: string,
    referenced: readonly ResolvedCustomer[],
    named: { token: string; customerId: string; created: boolean },
  ): Promise<IdentityLinkProposal | null> {
    if (!named.created) return null;
    const seen = referenced.some((c) => c.customerId === named.customerId)
      ? [...referenced]
      : [...referenced, { ...named, facet: 'name' as const }];
    const link = proposeLink(seen);
    if (!link || link.orphanId !== named.customerId) return null;
    if (await customersRepo.hasKnownName(this.db, businessId, link.survivorId)) return null;
    return link;
  }

  /**
   * A supplier mention becomes a vaulted supplier row (migration 0050) —
   * the "later slice" spend.ts promised. Same fold as a customer name, in
   * its OWN match-key keyspace so a person who is both a customer and a
   * supplier never links across the two by accident. Null for a mention
   * too short to be anybody, which the caller records as "no supplier".
   */
  async resolveSupplierMention(
    businessId: string,
    mention: string,
  ): Promise<{ supplierId: string } | null> {
    const normalised = normaliseFacet('supplier_name', mention);
    if (normalised.length < 2) return null;
    const matchKey = matchKeyFor(businessId, 'supplier_name', normalised, this.config.matchKey);
    const nameCipher = encryptFacet(
      mention.trim(),
      this.config.vaultKey,
      `${businessId}:supplier_name`,
    );
    const found = await withBusiness(this.db, businessId, (tx) =>
      suppliersRepo.findOrCreateSupplier(tx, businessId, { nameCipher, matchKey }),
    );
    return { supplierId: found.supplierId };
  }

  /**
   * A storefront checkout's customer (fix-plan 6, M5b).
   *
   * Anchored on the PHONE, the fact that survives repeat orders, with the
   * typed name attached as a second facet on the same person when that
   * person has no name yet (G-60): a new phone, a phone-only customer, or a
   * checkout retried after its name attach failed. A customer who has a name
   * keeps it. Both go straight to the vault; neither ever reaches a model.
   * Null when the phone does not survive normalisation, so the caller can
   * answer with a sentence instead of vaulting seven stray digits.
   *
   * The typed name is UNTRUSTED testimony from an anonymous buyer (owner
   * decision, G-60). It is stored encrypted for the order, its documents and
   * the dashboard, but with NO match key: it never becomes a known name the
   * merchant's chat is matched against, so a buyer calling themselves "No"
   * or "Pay" cannot capture those words. A name becomes trusted only when the
   * merchant establishes it (a mention in chat, a dashboard customer); the
   * two records are then joined by the merchant-confirmed link, never by the
   * buyer's say-so.
   */
  async resolveStorefrontCustomer(
    businessId: string,
    name: string,
    phone: string,
  ): Promise<{ token: string; customerId: string } | null> {
    if (normaliseFacet('phone', phone).length < 7) return null;
    const byPhone = await this.customerTokenFor(businessId, 'phone', phone);
    /* Attached whenever the phone's customer has no name yet, not only when
     * the phone is new: the phone row commits before the name, so a checkout
     * whose name attach failed must complete it on the retry (G-60). A
     * customer who already has a name keeps it, decided under a lock on the
     * customer so two checkouts at once cannot both add one. */
    if (name.trim().length > 0) {
      await customersRepo.addIdentityFacet(
        this.db,
        businessId,
        byPhone.customerId,
        {
          facet: 'name',
          ciphertext: encryptFacet(name, this.config.vaultKey, `${businessId}:name`),
          /* Untrusted: no match key, so never a known name (see above). */
          matchKey: null,
        },
        { unlessTheCustomerHasOne: true },
      );
    }
    return { token: byPhone.token, customerId: byPhone.customerId };
  }

  /**
   * Every match key a typed name could be stored under (G-60): as typed, and
   * in each Unicode composition, NFC and NFD. Yoruba tone marks arrive both
   * ways from different keyboards, and a stored name was keyed as it was
   * typed, so looking up all forms recognises it without re-keying anything.
   */
  private nameKeys(businessId: string, value: string): string[] {
    const forms = new Set([value, value.normalize('NFC'), value.normalize('NFD')]);
    return [
      ...new Set(
        [...forms].map((form) =>
          matchKeyFor(businessId, 'name', normaliseFacet('name', form), this.config.matchKey),
        ),
      ),
    ];
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
    /* A NEW name is keyed in one canonical composition, NFC, so two first
     * mentions of the same name in different compositions collide on
     * `identities_match_ux` and the loser resolves to the winner: one
     * person, one customer, however their first creation races (G-60).
     * Names stored before keep their as-typed key and are still found by
     * the lookups below, which try every composition. */
    const canonical = facet === 'name' ? value.normalize('NFC') : value;
    const normalised = normaliseFacet(facet, canonical);
    const matchKey = matchKeyFor(businessId, facet, normalised, this.config.matchKey);

    /* A name in another Unicode composition is the same person (G-60). */
    const candidates = facet === 'name' ? this.nameKeys(businessId, value) : [matchKey];
    for (const key of candidates) {
      const existing = await customersRepo.findCustomerByMatchKey(this.db, businessId, facet, key);
      if (existing) {
        return { token: existing.token, customerId: existing.id, facet, created: false };
      }
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
