import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { AnthropicTransport } from './anthropic.transport.js';
import { Interpreter } from './interpreter.service.js';
import { MODEL_TRANSPORT, ProviderUnreachable, type ModelTransport } from './transport.js';

// Re-exported for convenience; the token itself is defined in transport.ts so
// that this module and the service it provides do not import each other.
export { MODEL_TRANSPORT };

/**
 * A transport that refuses rather than one that is absent.
 *
 * Without an API key the honest options are "fail at boot" or "behave as if
 * the provider is down". Failing at boot would stop a developer running the
 * web app to look at a page, and the deterministic router already answers most
 * messages without a model — so a missing key degrades the product rather than
 * breaking it.
 *
 * It throws `ProviderUnreachable` specifically, which the interpreter already
 * knows to handle by handing the merchant's quota slot back. There is nothing
 * special-cased about the no-key path; it takes the same route as a provider
 * outage because that is what it is.
 */
class NoTransportConfigured implements ModelTransport {
  send(): Promise<never> {
    return Promise.reject(new ProviderUnreachable('ANTHROPIC_API_KEY is not set'));
  }
}

@Module({
  providers: [
    {
      provide: MODEL_TRANSPORT,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): ModelTransport =>
        config.anthropicApiKey
          ? new AnthropicTransport(config.anthropicApiKey)
          : new NoTransportConfigured(),
    },
    Interpreter,
  ],
  exports: [Interpreter, MODEL_TRANSPORT],
})
export class AiModule {}
