import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { storageFromConfig } from './storage-from-config.js';
import type { DocumentStorage } from './storage.js';

export const DOCUMENT_STORAGE = Symbol('DocumentStorage');

/** The choice and its reasons live in `storageFromConfig`. */
@Module({
  providers: [
    {
      provide: DOCUMENT_STORAGE,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): DocumentStorage => storageFromConfig(config),
    },
  ],
  exports: [DOCUMENT_STORAGE],
})
export class DocumentsModule {}
