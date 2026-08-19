import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { StorageUnavailable, type DocumentStorage, type StoredObject } from './storage.js';

/**
 * Cloudflare R2 (ADR 0006), which speaks S3.
 *
 * Chosen over S3 for one reason that dominates at this scale: R2 charges
 * nothing for egress. Rekoda's documents are read far more often than written —
 * a merchant resends a receipt, a customer opens it twice, a dispute reopens it
 * a month later — and on S3 that read pattern is the bill.
 */
export class R2Storage implements DocumentStorage {
  private readonly client: S3Client;

  constructor(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly bucket: string,
  ) {
    this.client = new S3Client({
      // R2 ignores the region but the SDK insists on one.
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, bytes: body.length };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = result.Body;
      if (!body) return null;
      return Buffer.from(await body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }
}

/**
 * The filesystem, for development and tests.
 *
 * Not a mock — it stores real bytes and reads them back, so a test proves the
 * document was written and is retrievable. What it does not prove is that R2's
 * credentials work, and nothing short of R2 can.
 */
export class LocalStorage implements DocumentStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    /**
     * A key reaches this class from a database column. Normalising and then
     * checking containment stops `../../etc/passwd` from becoming a write
     * outside the root — the keys we generate could never do that, but "the
     * keys we generate" is an assumption about every future caller.
     */
    const full = normalize(join(this.root, key));
    if (!full.startsWith(normalize(this.root))) {
      throw new StorageUnavailable('refusing a key that escapes the storage root');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<StoredObject> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { key, bytes: body.length };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

/**
 * No credentials, so no storage.
 *
 * Fails the way an outage does, which is what it is from the job's side. The
 * alternative — refusing to boot — would stop a developer running the stack,
 * and every other part of the product works without a bucket.
 */
export class NoStorageConfigured implements DocumentStorage {
  put(): Promise<never> {
    return Promise.reject(new StorageUnavailable('R2 credentials are not set'));
  }

  get(): Promise<null> {
    return Promise.resolve(null);
  }
}
