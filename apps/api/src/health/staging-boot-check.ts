/**
 * G-119 / OWN-77: a database marked as staging must never run beside a live Paystack key, whatever
 * the staging-tools flag says. The marker is the database's own claim to be staging; a live key says
 * the opposite, and the boot refuses rather than guess which is wrong. Called from `main.ts` before
 * any request is served.
 */
import { stagingToolsRepo, type Db } from '@rekoda/db';

export async function assertStagingMarkerNotLive(db: Db, paystackSecretKey: string): Promise<void> {
  if (!/^sk_live_/.test(paystackSecretKey)) return;
  if (await stagingToolsRepo.isStagingDatabase(db)) {
    throw new Error(
      'this database is marked as staging but the Paystack key is LIVE; refusing to boot',
    );
  }
}
