import { Controller, Get, Inject } from '@nestjs/common';
import { identity, type Db } from '@rekoda/db';
import type { HealthResponse } from '@rekoda/contracts';
import { DB } from '../db/db.module.js';
import { CONFIG, type ApiConfig } from '../config.js';

/**
 * The boot doctor's runtime half (MASTER-PLAN §3.4).
 *
 * Reports the migration count rather than just "up", because a database that
 * accepts connections while carrying no schema is the failure that looks
 * healthiest — and is the one that silently loses a merchant's first sale.
 *
 * It also names the build that answered (G-01): after a deploy or a rollback
 * the first question is which image is actually running, and the answer
 * should not need a shell on the host. A tag and a short SHA, both validated
 * at boot; nothing about the host, the database or any credential.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    // Liveness and schema are separate questions, and conflating them lies in
    // the more dangerous direction: a reachable database with no migrations
    // applied would otherwise report "down", sending whoever is on call to
    // debug the network instead of the deploy.
    const build = { release: this.config.release, commit: this.config.commit };
    if (!(await identity.ping(this.db))) {
      return { status: 'degraded', database: 'down', migrations: 0, ...build };
    }
    const migrations = await identity.migrationCount(this.db).catch(() => 0);
    return { status: migrations > 0 ? 'ok' : 'degraded', database: 'up', migrations, ...build };
  }
}
