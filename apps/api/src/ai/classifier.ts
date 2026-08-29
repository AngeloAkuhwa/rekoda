/**
 * The classifier role (docs/ai-model-strategy.md §1): cheap document-type
 * classification and junk detection, ONLY where it avoids a more expensive
 * call.
 *
 * That clause decides where this runs and where it must not. Typed messages
 * never come here — the deterministic router already answers the free ones
 * and everything else needs the interpreter anyway, so a classifier in front
 * of typed text would be a mandatory toll that saves nothing. The one place
 * a cheap read genuinely avoids an expensive one is a photographed page
 * whose extracted text is about to be sent to the interpreter: a meme, a
 * chat screenshot, a poster — pages with words on them and no transaction in
 * them — would otherwise burn a Sonnet interpretation and, since escalation
 * exists, quite possibly an Opus retry on top, to discover what one Haiku
 * call can say up front.
 *
 * FAIL OPEN. A classifier that cannot answer, cannot be reached, or is not
 * sure must never cost a merchant a real receipt: every unclear outcome
 * proceeds to the interpreter exactly as if this file did not exist. The
 * only action ever taken on its word alone is skipping a model call — never
 * writing, never posting, never refusing a document a human said was real.
 */

export const CLASSIFIER_TOOL_NAME = 'classify_document';

export const CLASSIFIER_SYSTEM =
  'You classify one page of extracted document text for a bookkeeping ' +
  'assistant. Decide what kind of page it is. You do not extract amounts, ' +
  'interpret transactions, or answer questions. When the page could ' +
  'plausibly be a business document of any kind, never say junk.';

export const CLASSIFIER_TOOL_DESCRIPTION =
  'Report what kind of page this text came from. Use "junk" ONLY when the ' +
  'page clearly contains no business transaction at all (a meme, a chat ' +
  'screenshot, a poster, song lyrics). If in any doubt, use "unsure".';

/** What a page can be. `junk` is the only class that changes behaviour. */
export const DOCUMENT_CLASSES = [
  'receipt',
  'invoice',
  'statement',
  'other_business_document',
  'junk',
  'unsure',
] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];

export const CLASSIFIER_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [...DOCUMENT_CLASSES],
      description: 'The kind of page this text was extracted from.',
    },
  },
  required: ['type'],
  additionalProperties: false,
};

/** Parse the tool answer, collapsing anything malformed to `unsure`. */
export function parseDocumentClass(toolInput: unknown): DocumentClass {
  const type = (toolInput as { type?: unknown } | null)?.type;
  return DOCUMENT_CLASSES.includes(type as DocumentClass) ? (type as DocumentClass) : 'unsure';
}
