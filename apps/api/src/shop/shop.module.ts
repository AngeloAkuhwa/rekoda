import { Module } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DbModule } from '../db/db.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { PublicShopController, ShopSettingsController } from './shop.controller.js';

/**
 * Two controllers, one public and one behind a session, in one module because
 * they are two halves of the same thing: what a merchant publishes and what a
 * customer sees. `RepliesModule` is here because `AuthService` takes the
 * sender, not because a shop sends anything.
 */
@Module({
  imports: [DbModule, DocumentsModule, RepliesModule],
  controllers: [PublicShopController, ShopSettingsController],
  providers: [AuthService, SessionGuard],
})
export class ShopModule {}
