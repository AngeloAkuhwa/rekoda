#!/usr/bin/env node
/**
 * THE argument parser contract-revision.mjs actually runs — exported so
 * tests exercise the REAL production parsing with REAL argv arrays, not
 * a recreated object. Declared boolean flags take no value; declared
 * value options require one; unknown options, missing values, and
 * invalid mode combinations FAIL (throw) instead of silently
 * misparsing. This replaces the generic "--option consumes the next
 * token" folding under which `--freeze --from 1` yielded
 * freeze="--from" and the freeze branch was unreachable.
 */
import { parseArgs } from 'node:util';

const BOOLEANS = ['baseline', 'freeze', 'post'];
const VALUES = [
  'repo',
  'issue',
  'revision',
  'reason',
  'from',
  'target',
  'sign-env',
  'expected-snapshot-hash',
];

export function parseContractRevisionCli(argv) {
  const options = {};
  for (const b of BOOLEANS) options[b] = { type: 'boolean' };
  for (const v of VALUES) options[v] = { type: 'string' };
  // strict: unknown options and positionals fail loudly.
  const { values } = parseArgs({ args: argv, options, strict: true, allowPositionals: false });
  // A value option that swallowed the NEXT option token means its real
  // value was missing — fail rather than misparse.
  for (const v of VALUES) {
    if (typeof values[v] === 'string' && values[v].startsWith('--')) {
      throw new Error(`Option --${v} is missing its value (got '${values[v]}').`);
    }
  }
  const modes = ['baseline', 'freeze', 'revision'].filter((m) =>
    m === 'revision' ? values.revision !== undefined : values[m] === true,
  );
  if (modes.length !== 1) {
    throw new Error(
      `Exactly one of --baseline, --freeze, or --revision K is required (got: ${modes.join(', ') || 'none'}).`,
    );
  }
  return { ...values, mode: modes[0] };
}
