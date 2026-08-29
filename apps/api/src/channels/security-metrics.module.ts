import { Global, Module } from '@nestjs/common';
import { SecurityMetrics } from './security-metrics.service.js';

/**
 * A cross-cutting singleton: the webhook controllers (in two different
 * modules) increment it, and the ops health controller reads it. Global so
 * there is exactly one instance whichever module resolves it - a per-module
 * copy would count each replica's rejections in a place the ops probe could
 * not see.
 */
@Global()
@Module({
  providers: [SecurityMetrics],
  exports: [SecurityMetrics],
})
export class SecurityMetricsModule {}
