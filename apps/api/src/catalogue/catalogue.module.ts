import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { CatalogueController } from './catalogue.controller.js';

/**
 * Flat providers, same as ReportsModule: guards resolve in the module that
 * declares the controller using them. `RepliesModule` is here because
 * `AuthService` takes the sender, not because the catalogue sends anything.
 */
@Module({
  imports: [DbModule, DocumentsModule, RepliesModule],
  controllers: [CatalogueController],
  providers: [AuthService, SessionGuard],
})
export class CatalogueModule {}
