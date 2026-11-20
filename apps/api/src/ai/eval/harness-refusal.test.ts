/**
 * A classifier refusal in the eval harness (OWN-98, G-134 review): production
 * ends a refused page with the could-not-read reply and never interprets it,
 * so the harness must not interpret it either, and must score it as a model
 * that answered unusably, never as a document rejected for being junk.
 */
import { describe, expect, it } from 'vitest';
import type { Interpreter } from '../interpreter.service.js';
import { EVAL_CASES } from './dataset.js';
import { runEvalCase } from './harness.js';

describe('a refused classification', () => {
  it('is never interpreted, and scores as an unusable answer', async () => {
    const page = EVAL_CASES.find(
      (c) => c.source === 'document_text' && c.expect.kind !== 'not_a_document',
    );
    expect(page).toBeDefined();
    let interpreted = false;
    const refusing = {
      classifyDocument: () => Promise.resolve('refused'),
      interpret: () => {
        interpreted = true;
        return Promise.reject(new Error('never interpreted'));
      },
    } as unknown as Interpreter;

    const result = await runEvalCase(refusing, 'b', page!);

    expect(interpreted).toBe(false);
    expect(result).toMatchObject({ outcome: 'invalid_response' });
    expect(result.outcome).not.toBe('rejected_document');
  });
});
