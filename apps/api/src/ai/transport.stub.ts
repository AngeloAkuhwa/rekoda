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
