import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { AnthropicTransport } from './anthropic.transport.js';
import { OpenAiTransport } from './openai.transport.js';
import { Interpreter } from './interpreter.service.js';
import { MODEL_TRANSPORT, ProviderUnreachable, type ModelTransport } from './transport.js';
import { assertModelIsPriced, registerRuntimeModelPrices } from './model-prices.js';
import { SPEECH_TO_TEXT, type SpeechToText } from './stt.js';
import { HttpSpeechToText, NoSpeechToTextConfigured } from './stt.http.js';

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
      useFactory: (config: ApiConfig): ModelTransport => {
        /**
         * One port, two providers, chosen by configuration.
         *
         * Everything that decides what Rekoda does — the ₦10bn ceiling, the
         * schema border, the spend ceiling, the conversation gates — sits
         * above this line and does not know which provider answered.
         */
        /* Prices before transports: a call that cannot be costed is a call
         * that quietly reports as free, so the check happens at boot rather
         * than at the first invoice. */
        registerRuntimeModelPrices(config.aiModelPrices ?? undefined);

        if (config.aiProvider === 'openai') {
          assertModelIsPriced(config.aiModelDefault, Boolean(config.openaiApiKey));
          /* `aiBaseUrl` is what makes this an OPENAI-COMPATIBLE transport
           * rather than an OpenAI one: DeepSeek weights on a US host, Groq,
           * Together, OpenRouter all speak this wire format. Undefined means
           * OpenAI itself, which is the SDK's own default. */
          return config.openaiApiKey
            ? new OpenAiTransport(config.openaiApiKey, undefined, config.aiBaseUrl ?? undefined)
            : new NoTransportConfigured();
        }
        assertModelIsPriced(config.aiModelDefault, Boolean(config.anthropicApiKey));
        return config.anthropicApiKey
          ? new AnthropicTransport(config.anthropicApiKey)
          : new NoTransportConfigured();
      },
    },
    /**
     * The transcriber, and WHERE it points is the promise.
     *
     * "Audio never leaves Rekoda" is true exactly while `STT_URL` names our
     * own sidecar (ADR 0005/0008). Without one, voice notes are answered
     * honestly rather than sent somewhere else by default.
     */
    {
      provide: SPEECH_TO_TEXT,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): SpeechToText =>
        config.sttUrl ? new HttpSpeechToText(config.sttUrl) : new NoSpeechToTextConfigured(),
    },
    Interpreter,
  ],
  exports: [Interpreter, MODEL_TRANSPORT, SPEECH_TO_TEXT],
})
export class AiModule {}
