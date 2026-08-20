export * from './money.js';
export * from './ledger.js';
export * from './reconciliation.js';
export * from './numbering.js';
export * from './router.js';
export * from './gates.js';
export * from './words.js';
export * from './sources.js';
export * from './invoice-layout.js';
export * from './payments.js';
export * from './ai-cost.js';
export * as replies from './replies.js';
export type { Reply } from './replies.js';

/**
 * `identity` is deliberately NOT re-exported here. It imports `node:crypto`,
 * and the barrel is what every client component reaches for — one
 * `import { formatKobo } from '@rekoda/core'` in a 'use client' file would
 * pull node:crypto into the browser bundle and break the build.
 *
 * Import it explicitly instead:  import { … } from '@rekoda/core/identity'
 *
 * `documents` is held back for the node:crypto reason too.
 *
 * `privacy` and `vault` are held back for the same reason, and for a second
 * one that matters more: `rehydrate` and `decryptFacet` are the two functions
 * that can undo the privacy gateway. Making them reachable from the barrel
 * that every component already imports would mean the safest path and the most
 * dangerous one share a spelling. An explicit `@rekoda/core/vault` import is a
 * thing a reviewer notices.
 */
