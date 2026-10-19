import { Module } from '@nestjs/common';
import { CONFIG, type ApiConfig } from '../config.js';
import { Interpreter } from './interpreter.service.js';
import { MODEL_TRANSPORT, VERIFIER_TRANSPORT, type ModelTransport } from './transport.js';
import { assertTranscriberIsPriced, registerRuntimeTranscriptionPrices } from './model-prices.js';
import { createModelTransport, createVerifierTransport } from './transport-factory.js';
import { NoSpeechToTextConfigured, SPEECH_TO_TEXT, type SpeechToText } from './stt.js';
import { NoTextExtractionConfigured, TEXT_EXTRACTION, type TextExtraction } from './ocr.js';
import { AUDIO_METADATA_PROBE, ContainerAudioProbe } from './audio-duration.js';
import { VisionTextExtraction } from './ocr.vision.js';
import { OpenAiSpeechToText } from './stt.openai.js';

// Re-exported for convenience; the tokens themselves are defined in
// transport.ts so that this module and the service it provides do not import
// each other.
export { MODEL_TRANSPORT, VERIFIER_TRANSPORT };

@Module({
  providers: [
    {
      provide: MODEL_TRANSPORT,
      inject: [CONFIG],
      /* One place decides the provider (G-07): the live evaluation builds
       * its transport from the same function, so it measures what runs. */
      useFactory: (config: ApiConfig): ModelTransport => createModelTransport(config),
    },
    /* The INDEPENDENT second reader for high-value documents (item 9); its
     * rules live beside the primary's in transport-factory.ts. */
    {
      provide: VERIFIER_TRANSPORT,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): ModelTransport | null => createVerifierTransport(config),
    },
    /**
     * The transcriber: OpenAI, explicitly, or nothing (ADR 0032).
     *
     * Voice is an opt-in feature with exactly one engine. There is no
     * self-hosted sidecar in the launch architecture, no second engine to
     * fall back to, and no way to enable voice without the key — config
     * validation refuses that boot. Disabled, voice notes are answered
     * honestly rather than sent anywhere. What /ai-privacy says about
     * audio is exactly what this factory does.
     */
    {
      provide: SPEECH_TO_TEXT,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): SpeechToText => {
        if (config.voiceTranscriptionEnabled && config.openaiApiKey) {
          /* Price before transport, per-minute edition: hosted transcription
           * spends provider money on every note, and a transcriber with no
           * registered rate is a transcriber whose every call reports as
           * free. */
          registerRuntimeTranscriptionPrices(config.aiTranscriptionPrices ?? undefined);
          assertTranscriberIsPriced(config.aiModelTranscriber, true);
          return new OpenAiSpeechToText(config.openaiApiKey, config.aiModelTranscriber);
        }
        return new NoSpeechToTextConfigured();
      },
    },
    /**
     * The document reader: Claude vision, explicitly, or nothing (ADR 0032).
     *
     * ADR 0024 fixed the PIPELINE — photo, then text extraction, then the
     * PII gateway, then a reasoning model — and that shape is untouched:
     * the reasoning model only ever sees tokenised text, because the
     * gateway tokenises text and cannot tokenise an image. The extraction
     * engine is Claude vision as a transcription-only processor, opt-in
     * and single: no sidecar, no fallback taken at request time — a
     * request that cannot reach the configured engine is refused, not
     * rerouted, because a boundary with a runtime fallback is not a
     * boundary. Disabled, a photograph is answered honestly and goes
     * nowhere.
     */
    {
      provide: TEXT_EXTRACTION,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): TextExtraction => {
        if (config.imageAiEnabled && config.anthropicApiKey) {
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
     * ffprobe service swaps the provider here and touches nothing else.
     */
    { provide: AUDIO_METADATA_PROBE, useClass: ContainerAudioProbe },
    Interpreter,
  ],
  exports: [
    Interpreter,
    MODEL_TRANSPORT,
    VERIFIER_TRANSPORT,
    SPEECH_TO_TEXT,
    TEXT_EXTRACTION,
    AUDIO_METADATA_PROBE,
  ],
})
export class AiModule {}
