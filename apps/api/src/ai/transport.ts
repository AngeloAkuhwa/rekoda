import type { TokenUsage } from '@rekoda/core';

/**
 * The seam between "we decided to ask a model" and "we asked one".
 *
 * A port rather than a direct SDK call, for one reason that matters: every
 * behaviour worth testing here — a refused quota, a malformed tool call, a
 * provider timeout, a hostile transcript — is a behaviour of the code AROUND
 * the model, and testing it against the real API would be slow, costly,
 * non-deterministic, and impossible in CI without a key. The fake transport in
 * the tests returns exactly the shapes the real one does.
 */
export interface ModelRequest {
  model: string;
  system: string;
  /** Already through the privacy gateway. Contains tokens, never identities. */
  userText: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens: number;
}

export interface ModelReply {
  /** The tool input, or null when the model answered without calling the tool. */
  toolInput: unknown | null;
  usage: TokenUsage;
  stopReason: string | null;
}

export interface ModelTransport {
  send(request: ModelRequest): Promise<ModelReply>;
}

/**
 * The injection token lives HERE, not in `ai.module.ts`.
 *
 * With it in the module, `interpreter.service` imports the module and the
 * module imports the service — a cycle. At runtime one of the two resolves to
 * `undefined` first, and Nest reports it as "argument at index [2] is not
 * available", which reads like a missing provider rather than an import loop.
 * A token beside the interface it identifies has nothing to cycle with.
 */
export const MODEL_TRANSPORT = Symbol('ModelTransport');

/**
 * The INDEPENDENT second reader for high-value documents (AI hardening
 * item 9). Its own token rather than a mode on MODEL_TRANSPORT, because
 * independence is the entire value: a verifier that shares the primary's
 * transport shares its failure modes, its provider, and its blind spots.
 * Resolves to null when no verifier is configured — dual extraction is
 * opt-in until the verifying provider is chosen and priced.
 */
export const VERIFIER_TRANSPORT = Symbol('VerifierTransport');

/** Raised when the provider could not be reached at all — no tokens were billed. */
export class ProviderUnreachable extends Error {
  override readonly name = 'ProviderUnreachable';
}
