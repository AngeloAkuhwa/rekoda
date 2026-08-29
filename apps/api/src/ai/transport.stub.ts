import type { ModelReply, ModelRequest, ModelTransport } from './transport.js';

/**
 * A transport that answers from a script.
 *
 * Shipped beside the real one rather than hidden in a test file because three
 * suites need it. Everything worth asserting about the interpreter — a refused
 * ceiling, output that fails the schema, a provider that cannot be reached, a
 * hostile transcript — is a behaviour of the code AROUND the model, and pinning
 * the model's answer is the only way to test that behaviour deterministically.
 *
 * It records the requests it was given, so a test can assert what was actually
 * sent: that the system prompt was the cacheable constant, and that the text
 * carried tokens rather than a phone number.
 */
export class StubTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly replies: Array<ModelReply | Error>) {}

  static answering(command: unknown, usage?: Partial<ModelReply['usage']>): StubTransport {
    return new StubTransport([
      {
        toolInput: { command },
        usage: { inputTokens: 1_800, outputTokens: 120, ...usage },
        stopReason: 'tool_use',
      },
    ]);
  }

  static failing(error: Error): StubTransport {
    return new StubTransport([error]);
  }

  /**
   * Change what the next call returns.
   *
   * A conversation is a sequence of different answers — a sale, then a
   * correction — and a stub that could only be scripted at construction could
   * not express one.
   */
  replyWith(command: unknown, usage?: Partial<ModelReply['usage']>): void {
    this.replies.length = 0;
    this.replies.push({
      toolInput: { command },
      usage: { inputTokens: 1_800, outputTokens: 120, ...usage },
      stopReason: 'tool_use',
    });
    this.requests.length = 0;
  }

  /**
   * Script the next calls VERBATIM, first to last, the last repeating.
   *
   * `replyWith` wraps its argument as `{ command }`, which is the
   * interpreter's tool shape and nobody else's — the classifier answers
   * `{ type }` and a sequence test needs a failure followed by a success.
   */
  script(...replies: Array<ModelReply | Error>): void {
    this.replies.length = 0;
    this.replies.push(...replies);
    this.requests.length = 0;
  }

  /** Forget what has been asked. A suite sharing one stub needs this per test. */
  reset(): void {
    this.requests.length = 0;
  }

  send(request: ModelRequest): Promise<ModelReply> {
    this.requests.push(request);
    const next = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)];
    if (!next) return Promise.reject(new Error('StubTransport: no reply scripted'));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}
