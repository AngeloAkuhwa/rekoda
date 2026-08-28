/**
 * The v1 public surface, in one barrel (canonical spec §27).
 *
 * Everything a v1 client can see is exported from here and from nowhere
 * else, which is what makes "is this part of the contract?" a question with
 * a mechanical answer. `shape.test.ts` walks this barrel; a schema that is
 * not exported here is not frozen, and a schema exported here cannot change
 * shape without the test saying so.
 */
export * from './envelope.js';
export * from './identity.js';
export * from './merchant.js';
export * from './webhooks.js';
