/**
 * Registering a callback, from the merchant's own session (PR-112).
 *
 * The seam, same as everywhere: the signing secret is minted and encrypted
 * here, the rows go through `webhooksRepo`, and the rules about signatures
 * and retries live in `@rekoda/core/webhooks`.
 *
 * The secret is bound to its endpoint id as associated data, so a blob moved
 * between rows or tenants fails authentication rather than decrypting into
 * somebody else's signing key. That binding is why the secret is minted in
 * two steps: the row exists before its secret is sealed to it.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { encryptFacet } from '@rekoda/core/vault';
import type {
  WebhookDeliveryView,
  WebhookEndpointView,
  WebhookSecretResponse,
} from '@rekoda/contracts';
import { publicApi } from '@rekoda/contracts';
import { webhooksRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';

/** 32 bytes of secret, hex. The same strength as a session token. */
const SECRET_BYTES = 32;

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  async register(
    businessId: string,
    input: { url: string; description: string | null; eventTypes: readonly string[] },
  ): Promise<WebhookSecretResponse> {
    const signingSecret = randomBytes(SECRET_BYTES).toString('hex');

    return withBusiness(this.db, businessId, async (tx) => {
      /* Sealed with a placeholder id first would be a lie, so the row is
       * created with a secret bound to nothing, then immediately rebound to
       * its own id. One transaction, so no window exists where an endpoint
       * holds an unbound secret. */
      const created = await webhooksRepo.createEndpoint(tx, {
        businessId,
        url: input.url,
        description: input.description,
        eventTypes: input.eventTypes,
        encryptedSecret: encryptFacet(signingSecret, this.config.vaultKey, businessId),
      });
      await webhooksRepo.rotateSecret(
        tx,
        businessId,
        created.id,
        encryptFacet(signingSecret, this.config.vaultKey, created.id),
      );
      return { endpoint: view(created), signingSecret };
    });
  }

  async list(
    businessId: string,
  ): Promise<{ endpoints: WebhookEndpointView[]; deliveries: WebhookDeliveryView[] }> {
    return withBusiness(this.db, businessId, async (tx) => {
      const endpoints = await webhooksRepo.endpointsFor(tx, businessId);
      const deliveries = await webhooksRepo.deliveriesFor(tx, businessId);
      return { endpoints: endpoints.map(view), deliveries: deliveries.map(deliveryView) };
    });
  }

  /** A new secret, effective immediately. The old one stops verifying. */
  async rotate(businessId: string, endpointId: string): Promise<WebhookSecretResponse | null> {
    const signingSecret = randomBytes(SECRET_BYTES).toString('hex');
    return withBusiness(this.db, businessId, async (tx) => {
      const rotated = await webhooksRepo.rotateSecret(
        tx,
        businessId,
        endpointId,
        encryptFacet(signingSecret, this.config.vaultKey, endpointId),
      );
      if (!rotated) return null;
      const endpoints = await webhooksRepo.endpointsFor(tx, businessId);
      const endpoint = endpoints.find((row) => row.id === endpointId);
      return endpoint ? { endpoint: view(endpoint), signingSecret } : null;
    });
  }

  async setStatus(
    businessId: string,
    endpointId: string,
    status: 'active' | 'disabled',
  ): Promise<boolean> {
    return withBusiness(this.db, businessId, (tx) =>
      webhooksRepo.setEndpointStatus(tx, businessId, endpointId, status),
    );
  }
}

function view(row: webhooksRepo.EndpointRow): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    /* Anything the estate no longer publishes is dropped rather than shown:
     * a subscription to a type that has been retired is not a type. */
    eventTypes: row.eventTypes.filter(isEventType),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
  };
}

function deliveryView(row: webhooksRepo.DeliveryRow): WebhookDeliveryView {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventType: row.eventType,
    status: row.status === 'delivered' ? 'delivered' : row.status === 'dead' ? 'dead' : 'pending',
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function isEventType(value: string): value is publicApi.v1.WebhookEventType {
  return (publicApi.v1.WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}
