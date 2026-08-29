/**
 * Meta's commerce catalog, spoken to over the Graph API (W3, PR-086).
 *
 * One call per sync: `/{catalogue_id}/items_batch` takes every item with
 * its own retailer_id and answers with per-item validation. The price is
 * formatted from INTEGER KOBO at the last moment — no float ever holds a
 * merchant's price — and availability is one of the two words Meta's
 * catalog speaks.
 *
 * Production enablement waits on W0: nothing constructs this against a
 * live catalog until a real WABA exists to own one. The shape is built now
 * (against test doubles) so that turning it on is a credential, not a
 * code change.
 */
import { Logger } from '@nestjs/common';
import type {
  CataloguePublisher,
  CataloguePushItem,
  CataloguePushOutcome,
} from './catalogue-publisher.js';

/** '150000' kobo → '1500.00 NGN', integer arithmetic only. */
export function catalogPrice(priceK: number, currency: string): string {
  const whole = Math.trunc(priceK / 100);
  const minor = Math.abs(priceK % 100);
  return `${whole}.${String(minor).padStart(2, '0')} ${currency}`;
}

export class MetaCataloguePublisher implements CataloguePublisher {
  private readonly log = new Logger(MetaCataloguePublisher.name);

  constructor(
    private readonly graphVersion = 'v21.0',
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  async publish(input: {
    accessToken: string;
    catalogueId: string;
    items: readonly CataloguePushItem[];
  }): Promise<CataloguePushOutcome[]> {
    const requests = input.items.map((item) => ({
      method: 'UPDATE',
      retailer_id: item.retailerId,
      data: {
        name: item.name,
        price: catalogPrice(item.priceK, item.currency),
        currency: item.currency,
        availability: item.availability,
      },
    }));

    const response = await fetch(
      `${this.baseUrl}/${this.graphVersion}/${encodeURIComponent(input.catalogueId)}/items_batch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ item_type: 'PRODUCT_ITEM', requests }),
      },
    );

    if (!response.ok) {
      /* The batch as a whole was refused: every item failed the same way,
       * and each carries the reason so the state table stays honest. */
      const text = await response.text().catch(() => '');
      this.log.warn(`catalogue batch refused: HTTP ${response.status}`);
      const error = `provider refused the batch (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ''}`;
      return input.items.map((item) => ({ retailerId: item.retailerId, ok: false, error }));
    }

    /* Meta's batch response carries validation_status entries only for
     * items with problems; silence is acceptance. */
    const body = (await response.json().catch(() => ({}))) as {
      validation_status?: Array<{
        retailer_id?: string;
        errors?: Array<{ message?: string }>;
      }>;
    };
    const failures = new Map<string, string>();
    for (const status of body.validation_status ?? []) {
      if (!status.retailer_id) continue;
      const messages = (status.errors ?? [])
        .map((e) => e.message)
        .filter((m): m is string => Boolean(m));
      if (messages.length > 0) failures.set(status.retailer_id, messages.join('; '));
    }
    return input.items.map((item) => {
      const error = failures.get(item.retailerId);
      return error
        ? { retailerId: item.retailerId, ok: false, error }
        : { retailerId: item.retailerId, ok: true };
    });
  }
}
