/**
 * What the system prompt tells the model about a question's window (Build 6).
 *
 * Whether "How much did I sell?" is asked about ("Sales for which period?")
 * or silently answered for this month depends on the model leaving `period`
 * null. The prompt is advice, not a guarantee, so the eval cases in
 * `eval/dataset.ts` (`query_period`) measure the model; this pins that the
 * advice is there and never says the opposite.
 */
import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from './prompt.js';

describe('the prompt on a question’s period', () => {
  it('says to leave the period null when no window was named', () => {
    expect(SYSTEM_PROMPT).toContain('leave period null and periodText null');
  });

  it('keeps today, week and month for exactly those windows, and custom for the rest', () => {
    expect(SYSTEM_PROMPT).toContain('Use today, week or month only when they said exactly');
    expect(SYSTEM_PROMPT).toContain('use custom and copy their own words');
  });

  it('never tells the model to fall back to a month', () => {
    const withoutTheProhibition = SYSTEM_PROMPT.replace('Do not default to month', '');
    expect(withoutTheProhibition.toLowerCase()).not.toMatch(/default(s|ing)? to (this )?month/);
    expect(withoutTheProhibition.toLowerCase()).not.toContain('assume this month');
  });
});

describe('the supplier reference (G-81, Codex review of 71fad6b)', () => {
  it('asks for the number WITH the word that names it, so a bare number keeps its context', () => {
    expect(SYSTEM_PROMPT).toContain('Copy only the word that names the document and the number');
  });

  it('never teaches a form core drops: no surrounding words like "their" (final-head review of eb0ad6d)', () => {
    expect(SYSTEM_PROMPT).not.toContain('their invoice 2231');
    expect(SYSTEM_PROMPT).toContain('never "their", "supplier" or other words around them');
  });
});
