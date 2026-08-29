import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { AnthropicTransport } from './anthropic.transport.js';
import { OpenAiTransport } from './openai.transport.js';
import { Interpreter } from './interpreter.service.js';
import { MODEL_TRANSPORT, ProviderUnreachable, type ModelTransport } from './transport.js';
import {
  assertRolesArePriced,
  assertTranscriberIsPriced,
  registerRuntimeModelPrices,
  registerRuntimeTranscriptionPrices,
} from './model-prices.js';
import { SPEECH_TO_TEXT, type SpeechToText } from './stt.js';
import { TEXT_EXTRACTION, type TextExtraction } from './ocr.js';
import { AUDIO_METADATA_PROBE, ContainerAudioProbe } from './audio-duration.js';
import { HttpTextExtraction, NoTextExtractionConfigured } from './ocr.http.js';
import { VisionTextExtraction } from './ocr.vision.js';
import { HttpSpeechToText, NoSpeechToTextConfigured } from './stt.http.js';
import { OpenAiSpeechToText } from './stt.openai.js';

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

        /* EVERY token-priced role, not just the interpreter. The classifier,
         * vision and escalation models each spend provider money on their
         * own id, and a role whose model has no price is a role whose every
         * call reports as free. The transcriber is deliberately absent: it
         * is priced per MINUTE, not per token, and its price is validated
         * where that mechanism lives. */
        const tokenRoles = [
          config.aiModelDefault,
          config.aiModelClassifier,
          config.aiModelVision,
          config.aiModelEscalation,
        ];

        if (config.aiProvider === 'openai') {
          assertRolesArePriced(tokenRoles, Boolean(config.openaiApiKey));
          /* `aiBaseUrl` is what makes this an OPENAI-COMPATIBLE transport
           * rather than an OpenAI one: DeepSeek weights on a US host, Groq,
           * Together, OpenRouter all speak this wire format. Undefined means
           * OpenAI itself, which is the SDK's own default. */
          return config.openaiApiKey
            ? new OpenAiTransport(config.openaiApiKey, undefined, config.aiBaseUrl ?? undefined)
            : new NoTransportConfigured();
        }
        assertRolesArePriced(tokenRoles, Boolean(config.anthropicApiKey));
        return config.anthropicApiKey
          ? new AnthropicTransport(config.anthropicApiKey, undefined, config.aiBaseUrl ?? undefined)
          : new NoTransportConfigured();
      },
    },
    /**
     * The transcriber, and WHERE it points decides what /ai-privacy may say.
     *
     * Three explicit configurations, never a silent fallback between them
     * (ADR 0027): `STT_URL` names the self-hosted AfriSpeech sidecar and
     * audio stays on infrastructure we run; otherwise an OpenAI key selects
     * hosted transcription — audio to a processor, back as text, tokenised
     * before any reasoning model sees it — which is the launch
     * configuration; and with neither, voice notes are answered honestly
     * rather than sent anywhere by default.
     */
    {
      provide: SPEECH_TO_TEXT,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): SpeechToText => {
        if (config.sttUrl) return new HttpSpeechToText(config.sttUrl);
        if (config.openaiApiKey) {
          /* Price before transport, per-minute edition: hosted transcription
           * spends provider money on every note, and a transcriber with no
           * registered rate is a transcriber whose every call reports as
           * free. The sidecar branch above needs no price — its per-call
           * provider cost is genuinely zero. */
          registerRuntimeTranscriptionPrices(config.aiTranscriptionPrices ?? undefined);
          assertTranscriberIsPriced(config.aiModelTranscriber, true);
          return new OpenAiSpeechToText(config.openaiApiKey, config.aiModelTranscriber);
        }
        return new NoSpeechToTextConfigured();
      },
    },
    /**
     * The text reader, and WHERE it points decides what /ai-privacy may say.
     *
     * ADR 0024 fixed the PIPELINE — photo, then text extraction, then the
     * PII gateway, then a reasoning model — and that shape is untouched.
     * What ADR 0027 changed is which engine may perform the extraction
     * step: `OCR_URL` selects the self-hosted sidecar; otherwise an
     * Anthropic key selects the vision model as a transcription-only
     * processor, which is the launch configuration. These are CONFIGURED
     * engines chosen at boot, never a fallback taken at request time — a
     * request that cannot reach its configured engine is refused, not
     * rerouted, because a boundary with a runtime fallback is not a
     * boundary. With neither, a photograph is answered honestly and goes
     * nowhere.
     */
    {
      provide: TEXT_EXTRACTION,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): TextExtraction => {
        if (config.ocrUrl) return new HttpTextExtraction(config.ocrUrl);
        if (config.anthropicApiKey) {
          return new VisionTextExtraction(config.anthropicApiKey, config.aiModelVision);
        }
        return new NoTextExtractionConfigured();
      },
    },
    /**
     * Reading a voice note's length before anything is spent on it.
     *
     * In process and with no configuration, because it parses containers
     * rather than calling anything. A deployment that would rather run an
     * ffprobe sidecar swaps the provider here and touches nothing else.
     */
    { provide: AUDIO_METADATA_PROBE, useClass: ContainerAudioProbe },
    Interpreter,
  ],
  exports: [Interpreter, MODEL_TRANSPORT, SPEECH_TO_TEXT, TEXT_EXTRACTION, AUDIO_METADATA_PROBE],
})
export class AiModule {}
