/**
 * Read-only. Parse rate of the bundled templates over fixtures/sms/idfc.json (no network, no writes).
 *
 *   npx tsx scripts/pilot-parse-rate.ts
 *
 * tsx is not a project dependency; `npx tsx` downloads it on first use. Exit code 1 when the target is not met.
 */
import fixtures from '../fixtures/sms/idfc.json';
import { bundledTemplates, parseSms } from '../src/core/parser';
import { evaluateFixtures, formatReport, type Fixture } from './pilotParseRate';

const report = evaluateFixtures(fixtures as unknown as Fixture[], bundledTemplates, parseSms);
console.log(formatReport(report));
process.exit(report.meetsTarget ? 0 : 1);
