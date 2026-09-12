import { Controller, Get, Inject } from '@nestjs/common';
import { bundledMigrationTags, identity, type Db } from '@rekoda/db';
import type { HealthResponse } from '@rekoda/contracts';
import { DB } from '../db/db.module.js';
import { CONFIG, type ApiConfig } from '../config.js';

/**
 * `ok` means the schema THIS build needs is there, not merely some schema: a
 * new image started before its migrate job ran would otherwise pass its
 * container health check, let web and Caddy start behind it, and fail at the
 * first route that touches the new tables. Every migration the build carries
 * must be applied, checked by tag (the runner records completion by tag, and
 * two diverging histories can agree on a count). Migrations the build does
 * not know about are fine: a rollback runs an older image against the newer,
 * expand-only schema (G-01).
 */
export function healthStatus(
  applied: ReadonlySet<string>,
  required: readonly string[],
): 'ok' | 'degraded' {
  return applied.size > 0 && required.every((tag) => applied.has(tag)) ? 'ok' : 'degraded';
}

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
  /** The migrations this build carries, read once from its journal. */
  private readonly required = bundledMigrationTags();

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
    const applied = await identity.appliedMigrationTags(this.db).catch(() => new Set<string>());
    return {
      status: healthStatus(applied, this.required),
      database: 'up',
      migrations: applied.size,
      ...build,
    };
  }
}
