/**
 * Operator-initiated erasure of one email address (OD-39, migration 0191).
 *
 * Two places can hold an address an operator is asked to erase:
 *
 *   1. The cross-business billing-email confirmation counter (0185): a keyed HMAC of the address,
 *      no business id. Always erased: its rows go, so the address's shared hourly allowance and
 *      cooldown (5 an hour, 60 seconds apart; OWN-58, OWN-66) start again. This is also how an
 *      operator clears an allowance that another business used up (ADR 0036).
 *   2. One business's billing email, sealed under the vault key. Only when the operator names the
 *      business (tenant boundary: an erasure never searches other businesses' addresses), and only
 *      when that business's address IS the one being erased; another address is left alone.
 *
 * Both happen in ONE transaction, business row lock first then the address lock (the order the
 * confirmation claim uses), so a partial erasure cannot commit: on any failure nothing changes and
 * the request can simply be repeated. A repeat removes nothing more and leaves another receipt.
 *
 * Kept, on purpose: email suppressions and customer email opt-outs (stop records, so mail does not
 * resume), customer identity facets (erased per business by EraseData, lane 1), and every invoice,
 * receipt and ledger row. The address is never logged, stored, audited or returned.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { OpsEmailErasureRequest, OpsEmailErasureResponse } from '@rekoda/contracts';
import { billingEmailAddressKeyFor, decryptFacet } from '@rekoda/core/vault';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';

/** The named business does not exist (or this role cannot see it). */
export class ErasureBusinessNotFound extends Error {
  constructor() {
    super('no such business');
    this.name = 'ErasureBusinessNotFound';
  }
}

/**
 * The named business's billing email is sealed but this vault key cannot open it, so whether it is
 * the address being erased is unknown. Nothing is changed (the request rolls back) and the
 * operator is told, rather than being answered `erased: true` while the address stays stored.
 */
export class ErasureSealUnreadable extends Error {
  constructor() {
    super('the stored billing email could not be opened');
    this.name = 'ErasureSealUnreadable';
  }
}

const normalise = (address: string): string => address.trim().toLowerCase();

@Injectable()
export class EmailErasureService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  async erase(input: OpsEmailErasureRequest, operator: string): Promise<OpsEmailErasureResponse> {
    const address = normalise(input.address);
    const addressKey = billingEmailAddressKeyFor(address, this.config.matchKey);

    if (input.businessId === undefined) {
      const counterRowsRemoved = await this.db.transaction((tx) =>
        subscriptionsRepo.eraseEmailAddressFromCounter(tx, {
          addressKey,
          operator,
          reason: input.reason,
          billingEmailCleared: false,
        }),
      );
      return { erased: true, counterRowsRemoved, billingEmail: 'not_requested' };
    }

    const businessId = input.businessId;
    return withBusiness(this.db, businessId, async (tx) => {
      const current = await subscriptionsRepo.billingEmailSealedForUpdate(tx, businessId);
      if (!current.found) throw new ErasureBusinessNotFound();

      let billingEmail: OpsEmailErasureResponse['billingEmail'] = 'not_on_file';
      if (current.sealed !== null) {
        let onFile: string;
        try {
          onFile = decryptFacet(
            current.sealed,
            this.config.vaultKey,
            `billing-email:${businessId}`,
          );
        } catch {
          /* A seal this key cannot open is neither a match nor proof of a different address:
           * refuse, so the transaction rolls back and nothing is reported as erased. */
          throw new ErasureSealUnreadable();
        }
        if (normalise(onFile) === address) {
          await subscriptionsRepo.eraseBillingEmail(tx, businessId, operator);
          billingEmail = 'cleared';
        } else {
          billingEmail = 'different_address';
        }
      }
      const counterRowsRemoved = await subscriptionsRepo.eraseEmailAddressFromCounter(tx, {
        addressKey,
        operator,
        reason: input.reason,
        billingEmailCleared: billingEmail === 'cleared',
      });
      return { erased: true as const, counterRowsRemoved, billingEmail };
    });
  }
}
