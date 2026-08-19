# 0008 — STT baseline is an AfriSpeech-tuned Whisper, not stock Whisper

**Status:** Accepted
**Date:** 2026-08-19
**Refines:** [0005](0005-pii-gateway-scope.md) (layer 4 — voice)

## Context

ADR 0005 committed to self-hosted `faster-whisper` so merchant audio never
leaves Rekoda. It did not say *which weights*, and the implicit assumption was
stock `whisper-large-v3`. Published benchmarks make that assumption dangerous.

AfriSpeech-MultiBench measures `whisper-large-v3` — sub-4% WER on LibriSpeech —
at **30–45% WER on African-accented English**, rising above 70% on
named-entity-rich utterances. Rekoda's utterances are *exactly* the bad case:
they are dense with names and amounts, in Nigerian English and pidgin, often
recorded in a market. Shipping stock Whisper would have failed the M3 benchmark
and forced the provider fallback — which is the one outcome that costs us the
"audio never leaves Rekoda" claim, the strongest sentence on the trust page.

Fine-tuned variants close most of the gap. AfriSpeech-200 is ~200 hours of
African-accented English, **67% Nigerian accents**, and openly published models
fine-tuned on it exist and are self-hostable.

## Decision

1. **Baseline weights are `intronhealth/afrispeech-whisper-medium-all`**
   (Whisper medium fine-tuned on AfriSpeech-200), running in the same
   CTranslate2/`faster-whisper` sidecar. Self-hosting is unchanged, so the
   privacy claim in ADR 0005 is unaffected.
2. **Benchmark three candidates head-to-head at M3**, not one against a
   provider: the AfriSpeech-tuned medium, stock `large-v3`, and
   `NCAIR1/NigerianAccentedEnglish`. A fine-tune on a smaller base is not
   automatically better than a larger stock base on *our* utterance shape —
   medium is weaker at baseline, and the fine-tune advantage has to be shown,
   not assumed.
3. **The gate metric is entity-level accuracy, not WER.** Rekoda does not need
   a correct transcript. It needs the amount, the quantity, and a name string
   close enough for the layer-1 fuzzy match against the merchant's own customer
   list — and CG2 shows a preview before anything is issued. Measure:
   * money-field exact accuracy ("forty-five k" → `4_500_000` kobo),
   * quantity exact accuracy,
   * name match-rate against a known customer list,
   * WER, recorded but not decisive.
   Corpus: ≥200 real Nigerian merchant voice notes (accents, pidgin,
   code-switching, market noise), held out and versioned.
4. **Fallback ladder, in order:** self-hosted tuned model → **Intron Sahara**
   (the AfriSpeech authors' hosted ASR, best published performer on African
   English, an African provider under DPA terms) → OpenAI. Each rung down
   requires the `/ai-privacy` copy to change in the same release.

## Consequences

The M3 benchmark stops being a coin-toss on a claim we have already published.
Model choice becomes a versioned artefact: the benchmark corpus and results
live in the repo, and any weight change re-runs the gate.

**The improvement flywheel is deferred, not adopted.** Corrected transcripts
from the CG2 confirmation gate would be an excellent Nigerian-market training
set, and it is tempting to harvest them from day one. Under NDPA 2023 that
requires **explicit, specific, separately-obtained and revocable consent** —
it cannot be bundled into the ToS, cannot be a pre-ticked box, and cannot be a
condition of using the product. Until that consent flow is designed, reviewed
and shipped, **no merchant audio or transcript is retained for training**, and
the retention table on `/privacy` continues to say audio is not stored.
Designing that flow is a task in M3, gated behind ADR 0005's honesty rule.

## Sources

* AfriSpeech-MultiBench — https://arxiv.org/html/2511.14255
* AfriSpeech-200 (TACL) — https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00627/118796/AfriSpeech-200-Pan-African-Accented-Speech-Dataset
* https://huggingface.co/intronhealth/afrispeech-whisper-medium-all
* https://huggingface.co/NCAIR1/NigerianAccentedEnglish
