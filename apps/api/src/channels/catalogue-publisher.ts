/**
 * The port a WABA catalogue is published through (spec §3.2; W3, PR-086).
 *
 * Provider-shaped, not provider-owned: the service decides WHAT to push
 * (the diff off the merchant's own products) and this decides only how the
 * wire is spoken. Results come back PER ITEM, because Meta accepts and
 * refuses item by item and a batch that failed as a lump would hide which
 * product the merchant needs to fix.
 */

export interface CataloguePushItem {
  /** The identity the provider knows the item by: our product id. */
  retailerId: string;
  name: string;
  priceK: number;
  currency: 'NGN';
  availability: 'in stock' | 'out of stock';
}

export interface CataloguePushOutcome {
  retailerId: string;
  ok: boolean;
  /** The provider's stated reason when not ok. Advisory prose for the
   * merchant's next edit — never parsed, never a routing input. */
  error?: string | null;
}

export interface CataloguePublisher {
  publish(input: {
    accessToken: string;
    catalogueId: string;
    items: readonly CataloguePushItem[];
  }): Promise<CataloguePushOutcome[]>;
}

/** Injection token, away from any module (the MODEL_TRANSPORT lesson). */
export const CATALOGUE_PUBLISHER = Symbol('CataloguePublisher');
