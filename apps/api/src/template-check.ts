/**
 * `node dist/template-check.js`: this container's WhatsApp template settings, classified without
 * printing a value (OWN-93; the rule lives in channels/template-report.ts). The read-only staging
 * check runs it in the running api and worker; the staging deploy runs it in the new image, before
 * anything is stopped, so a setting the new release would refuse to boot with stops the deploy
 * while the old release still runs.
 *
 * Exit 0: the settings would boot (a slot may still be unset; the report says which). Exit 1: they
 * would not; each reason is printed on stderr by variable name. Like edge-check.ts it runs
 * unconditionally and nothing imports it.
 */
import { templateReport } from './channels/template-report.js';

const report = templateReport(process.env);
for (const line of report.lines) console.log(line);
for (const problem of report.refused) console.error(`${problem.env} ${problem.problem}`);
console.log(report.refused.length === 0 ? 'RESULT BOOTS' : 'RESULT REFUSED');
process.exit(report.refused.length === 0 ? 0 : 1);
