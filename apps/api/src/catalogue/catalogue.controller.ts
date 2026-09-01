/**
 * The price list, as something a merchant can change (MASTER-PLAN §5.3.5).
 *
 * Its own controller rather than another few routes on reports, because the
 * two surfaces have opposite jobs: reports answer questions about what has
 * already happened and cannot alter anything, and every route here writes.
 * Mixing them would put the shop's only editable surface behind a module
 * whose whole design note says it never edits.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  catalogueResponse,
  createProductRequest,
  editProductRequest,
  type CatalogueResponse,
  type CreateProductResponse,
  type EditProductResponse,
  type UploadImageResponse,
} from '@rekoda/contracts';
import { extensionFor, MAX_IMAGE_BYTES, sniffImageType } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { catalogueRepo, objectDeletionsRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { DB } from '../db/db.module.js';
import { describeFailure } from '../jobs/runner.js';
import { DOCUMENT_STORAGE } from '../documents/documents.module.js';
import { StorageUnavailable, type DocumentStorage } from '../documents/storage.js';
import { productImageKey } from './image-key.js';

/** What a Fastify reply needs to be for an image to go back down it. */
interface ImageReply {
  header(name: string, value: string): ImageReply;
  code(status: number): ImageReply;
  send(body: Buffer | string): void;
}

/** The multipart file this controller reads, as `@fastify/multipart` gives it. */
interface MultipartRequest extends AuthedRequest {
  isMultipart?: () => boolean;
  file?: (options?: { limits?: { fileSize?: number } }) => Promise<
    | {
        toBuffer(): Promise<Buffer>;
        file?: { truncated?: boolean };
        fields?: Record<string, { value?: unknown } | undefined>;
      }
    | undefined
  >;
}

@Controller('v1/catalogue')
@UseGuards(SessionGuard, RolesGuard)
export class CatalogueController {
  private readonly log = new Logger(CatalogueController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  @Get()
  async list(@Req() request: AuthedRequest): Promise<CatalogueResponse> {
    const businessId = request.auth!.businessId;
    const catalogue = await withBusiness(this.db, businessId, (tx) =>
      catalogueRepo.catalogueFor(tx, businessId),
    );
    return catalogueResponse.parse({
      products: catalogue.rows.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        unitPriceK: item.unitPriceK,
        unitCostK: item.unitCostK,
        /* A path, never the key. The key is where the bucket keeps it and
         * says nothing a browser can use; this is the route that will hand
         * the bytes back, having checked who is asking. */
        imagePath: item.imageKey ? `/v1/catalogue/${item.id}/image` : null,
        active: item.active,
        onHand: item.onHand,
      })),
      /* All four from SQL over the whole catalogue, never from the page.
       * Listed with no price is the state that stops a shop selling and the
       * one a merchant cannot see by scanning a long list; counted off the
       * page it reported zero to a shop with twelve of them. Hidden products
       * are excluded: not being for sale is why they have no price. */
      total: catalogue.count,
      listed: catalogue.listed,
      hidden: catalogue.hidden,
      unpriced: catalogue.unpriced,
    });
  }

  /* Delegates run the shop floor, so products and their photos are theirs to
   * keep current; an accountant's access stays view only. */
  @Post('product')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async edit(@Req() request: AuthedRequest, @Body() body: unknown): Promise<EditProductResponse> {
    const parsed = editProductRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a product and something to change');

    /* Rebuilt key by key rather than spread, so ABSENT stays absent. A
     * spread under `exactOptionalPropertyTypes` turns a field the merchant
     * did not touch into an explicit `undefined`, and the repo reads
     * presence to decide what to write: every unedited field would be
     * cleared by a form that only meant to change one. */
    const edit: catalogueRepo.CatalogueEdit = {};
    if ('description' in parsed.data) edit.description = parsed.data.description ?? null;
    if ('unitPriceK' in parsed.data) edit.unitPriceK = parsed.data.unitPriceK ?? null;
    if ('unitCostK' in parsed.data) edit.unitCostK = parsed.data.unitCostK ?? null;
    if ('active' in parsed.data) edit.active = parsed.data.active!;

    const businessId = request.auth!.businessId;
    const outcome = await withBusiness(this.db, businessId, async (tx) => {
      /* The rename runs first and can refuse alone: a form that renames AND
       * reprices should not half-apply the price under a refused name. */
      if (parsed.data.name !== undefined) {
        const renamed = await catalogueRepo.renameProduct(
          tx,
          businessId,
          parsed.data.id,
          parsed.data.name,
        );
        if (renamed !== 'renamed') return renamed;
        if (Object.keys(edit).length === 0) return 'updated' as const;
      }
      return catalogueRepo.editProduct(tx, businessId, parsed.data.id, edit);
    });
    return { outcome };
  }

  /**
   * Create a product from the dashboard (fix-plan 5, H2c). Chat could always
   * bring one into being by mentioning it; the dashboard could only edit
   * what chat had made. Same fold, same never-a-twin rule.
   */
  @Post('products')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async create(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CreateProductResponse> {
    const parsed = createProductRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a name of 2 to 80 characters');
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      catalogueRepo.createProduct(tx, businessId, {
        name: parsed.data.name,
        ...(parsed.data.unitPriceK === undefined ? {} : { unitPriceK: parsed.data.unitPriceK }),
      }),
    );
  }

  /**
   * Attach a photo.
   *
   * Four refusals, in the order that matters. Size first, enforced by the
   * parser rather than by measuring afterwards, so a merchant sending a
   * hundred megabytes never gets a hundred megabytes into this process.
   * Then what the bytes ARE, read from the file itself: the `Content-Type`
   * that came with the upload is whatever a browser guessed from a filename,
   * and a document stored under a claimed image type would be served back
   * and run in somebody's browser on our own origin. Then whether the product
   * is even this merchant's. Only then the bucket.
   *
   * That third refusal used to come LAST, after the bytes were already
   * written, and nothing collected what it left behind. Two objects leaked
   * that way. The one the request never had a home for: anyone holding a
   * session could POST to `/v1/catalogue/<any uuid>/image` and put bytes in
   * the bucket for free, unbounded, because the refusal arrived after the
   * write. And the one a successful upload displaced: `setProductImage` hands
   * back the key it replaced precisely so the caller can bin it, and the
   * caller dropped it, so every re-upload since launch has left the old photo
   * behind with no row naming it.
   *
   * So: ask first, and treat the bucket as something that must be cleaned up
   * after rather than something that only ever grows. Neither the reorder nor
   * the compensation is sufficient alone — the product can still be deleted
   * between the check and the update — which is why both are here.
   */
  @Post(':id/image')
  @Roles('owner', 'delegate')
  @HttpCode(200)
  async uploadImage(
    @Req() request: MultipartRequest,
    @Param('id') id: string,
  ): Promise<UploadImageResponse> {
    if (!isUuid(id)) throw new BadRequestException('a product to attach it to');
    if (!request.isMultipart?.()) throw new BadRequestException('the photo, as a file upload');

    const upload = await request.file?.({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!upload) throw new BadRequestException('the photo, as a file upload');

    const bytes = await upload.toBuffer();
    /* `truncated` is the parser saying it stopped at the limit. Checking the
     * length instead would pass a file that is exactly the ceiling and was
     * cut off there, and store half a photo. */
    if (upload.file?.truncated) return { outcome: 'too_large', maxBytes: MAX_IMAGE_BYTES };

    const type = sniffImageType(bytes);
    if (!type) return { outcome: 'not_an_image' };

    const businessId = request.auth!.businessId;
    /* Before the bucket, not after. Row-level security answers this for the
     * tenant, so a product belonging to another shop reads as absent. */
    const exists = await withBusiness(this.db, businessId, (tx) =>
      catalogueRepo.productExists(tx, businessId, id),
    );
    if (!exists) return { outcome: 'not_found' };

    const key = productImageKey(businessId, extensionFor(type));
    try {
      await this.storage.put(key, bytes, type);
    } catch (error: unknown) {
      /* No bucket configured is a deployment fact, not a merchant's mistake,
       * and it is refused out loud rather than by a row pointing at nothing. */
      if (error instanceof StorageUnavailable) return { outcome: 'no_storage' };
      throw error;
    }

    let attached: Awaited<ReturnType<typeof catalogueRepo.setProductImage>>;
    try {
      attached = await withBusiness(this.db, businessId, async (tx) => {
        const result = await catalogueRepo.setProductImage(tx, businessId, id, key);
        /* Enqueued INSIDE the transaction that orphans it, which is the
         * queue's whole contract: if this update rolls back, the old key is
         * still the live one and no promise to delete it survives. */
        if (result.outcome === 'updated' && result.replacedKey && result.replacedKey !== key) {
          await objectDeletionsRepo.enqueueObjectDeletions(
            tx,
            businessId,
            [result.replacedKey],
            'image_replaced',
          );
        }
        return result;
      });
    } catch (error: unknown) {
      /* The bytes are already in the bucket and nothing will ever name them.
       * Bin them before rethrowing, or a failed upload leaves litter. */
      await this.discard(businessId, key);
      throw error;
    }

    if (attached.outcome === 'not_found') {
      /* The product existed a moment ago and does not now. Rare, and the
       * reason the check above is not the whole fix. */
      await this.discard(businessId, key);
      return { outcome: 'not_found' };
    }

    return { outcome: 'stored', imagePath: `/v1/catalogue/${id}/image` };
  }

  /**
   * Get rid of an object nothing points at.
   *
   * Tried directly first because that is one call against a bucket that is
   * almost always up, and it leaves nothing behind to read. A provider that
   * refuses is not allowed to end the story: the key goes on the same queue
   * the retention and erasure paths use, so the work stays visible and is
   * retried rather than logged and forgotten.
   *
   * If even the enqueue fails there is nothing honest left to do here. The
   * caller is already returning the right answer to the merchant, and turning
   * their correct `not_found` into a 500 because OUR bucket needs tidying
   * would be reporting our problem as theirs. So it is logged loudly and the
   * response stands.
   */
  private async discard(businessId: string, key: string): Promise<void> {
    try {
      await this.storage.delete(key);
      return;
    } catch (error: unknown) {
      this.log.warn(
        `orphaned object not deleted, queueing: ${redactForLog(describeFailure(error))}`,
      );
    }
    try {
      await withBusiness(this.db, businessId, (tx) =>
        objectDeletionsRepo.enqueueObjectDeletions(tx, businessId, [key], 'upload_orphaned'),
      );
    } catch (error: unknown) {
      this.log.error(
        `orphaned object could not even be queued: ${redactForLog(describeFailure(error))}`,
      );
    }
  }

  /**
   * Hand the photo back.
   *
   * Behind the session guard and pinned to the tenant, so a product id from
   * one shop cannot fetch another's image even though ids are opaque. The
   * storage key is unguessable as well, which makes this the second lock
   * rather than the only one.
   *
   * `Content-Type` comes from the bytes again rather than from anything
   * stored: it is one function call, and it means a wrong type can never be
   * served even if something upstream ever wrote one.
   */
  @Get(':id/image')
  async image(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Res() reply: ImageReply,
  ): Promise<void> {
    if (!isUuid(id)) throw new BadRequestException('a product');

    const businessId = request.auth!.businessId;
    const key = await withBusiness(this.db, businessId, (tx) =>
      catalogueRepo.imageKeyFor(tx, businessId, id),
    );
    if (!key) {
      reply.code(404).send('Not found');
      return;
    }

    const bytes = await this.storage.get(key).catch(() => null);
    if (!bytes) {
      reply.code(404).send('Not found');
      return;
    }

    const type = sniffImageType(bytes);
    if (!type) {
      reply.code(404).send('Not found');
      return;
    }

    reply
      .header('content-type', type)
      /* Private, because it is behind a session. A shared cache holding one
       * merchant's product photo and serving it to the next request on the
       * same edge is the whole reason this header is not `public`. */
      .header('cache-control', 'private, max-age=300')
      .header('content-disposition', 'inline')
      /* The bytes were sniffed above, but a browser that ignores the type
       * and sniffs for itself is exactly what this turns off. */
      .header('x-content-type-options', 'nosniff')
      .send(bytes);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID.test(value);
}
