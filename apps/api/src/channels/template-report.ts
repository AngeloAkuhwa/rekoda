/**
 * The template report the read-only staging check and the staging deploy ask each container for
 * (`dist/template-check.js`, OWN-93). It classifies the process's OWN template settings with the
 * same table and validator the API boots with (`template-slots.ts`), so the scripts carry no list
 * of slots, names or languages of their own.
 *
 * It prints no value: each setting reads unset, set or invalid, and the settings as a whole are
 * reduced to a digest, which the staging check only compares between the api and the worker
 * (SAME or DIFFERENT) and never prints. It cannot know whether Meta approved a template.
 */
import { createHash } from 'node:crypto';
import {
  TEMPLATE_SLOTS,
  templateConfigProblems,
  templateSlotStatus,
  type TemplateConfigProblem,
} from './template-slots.js';

export interface TemplateReport {
  /** `SLOT <variable> <required|optional> <name state> <language state>`, then `DIGEST <hex>`. */
  lines: string[];
  /** What would refuse a boot (`config.ts`); empty when the settings would boot. */
  refused: TemplateConfigProblem[];
}

export function templateReport(env: NodeJS.ProcessEnv): TemplateReport {
  const lines = templateSlotStatus(env).map(
    (s) => `SLOT ${s.env} ${s.required ? 'required' : 'optional'} ${s.name} ${s.locale}`,
  );
  const settings = TEMPLATE_SLOTS.map((s) => [s.env, env[s.env] ?? '', env[s.localeEnv] ?? '']);
  lines.push(`DIGEST ${createHash('sha256').update(JSON.stringify(settings)).digest('hex')}`);
  return { lines, refused: templateConfigProblems(env) };
}
