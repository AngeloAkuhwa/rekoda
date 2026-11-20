/**
 * The G-134 probe in plan mode: the bodies it would send are the production
 * transport's own, for the real prompt, tools and ceilings, and nothing
 * leaves the process.
 */
import { describe, expect, it } from 'vitest';
import { PROBE_MESSAGE, probeCases, runProbe } from './probe-tool-choice.js';
import { SYSTEM_PROMPT, TOOL_NAME } from '../prompt.js';
import { CLASSIFIER_TOOL_NAME } from '../classifier.js';
import { CLASSIFIER_MAX_TOKENS, COMMAND_MAX_TOKENS } from '../interpreter.service.js';

const MODELS = {
  interpreter: 'claude-sonnet-5-5',
  escalation: 'claude-opus-5-5',
  classifier: 'claude-haiku-4-5',
};

type Body = {
  model: string;
  max_tokens: number;
  system: Array<{ text: string }>;
  tools: Array<{ name: string; strict?: boolean; input_schema: Record<string, unknown> }>;
  tool_choice: unknown;
  messages: unknown;
};

async function bodies(): Promise<Map<string, Body>> {
  const results = await runProbe(probeCases(MODELS), null);
  return new Map(results.map((r) => [r['case'] as string, r['requestBody'] as Body]));
}

describe('the G-134 probe, in plan mode', () => {
  it('builds the interpreter and escalation requests the API sends, on their models', async () => {
    const sent = await bodies();
    for (const [name, model] of [
      ['interpreter', MODELS.interpreter],
      ['escalation', MODELS.escalation],
    ] as const) {
      const body = sent.get(name)!;
      expect(body.model).toBe(model);
      expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      expect(body.max_tokens).toBe(COMMAND_MAX_TOKENS);
      expect(body.system[0]?.text).toBe(SYSTEM_PROMPT);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0]?.name).toBe(TOOL_NAME);
      // The full business-command schema goes non-strict: it is over the strict limits.
      expect(body.tools[0]).not.toHaveProperty('strict');
      expect(JSON.stringify(body.tools[0]?.input_schema)).toContain('"maximum"');
      expect(body.messages).toEqual([{ role: 'user', content: PROBE_MESSAGE }]);
    }
  });

  it('builds the classifier request strict, with its own ceiling', async () => {
    const body = (await bodies()).get('classifier')!;
    expect(body.model).toBe(MODELS.classifier);
    expect(body.tools[0]).toMatchObject({ name: CLASSIFIER_TOOL_NAME, strict: true });
    expect(body.max_tokens).toBe(CLASSIFIER_MAX_TOKENS);
  });

  it('a synthetic message only: no phone number, no name, no amount beyond the sentence', () => {
    expect(PROBE_MESSAGE).not.toMatch(/\+?\d{10,}/);
    expect(PROBE_MESSAGE).toContain('CUSTOMER_7K2');
  });
});
