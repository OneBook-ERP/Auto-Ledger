// Keeps docs/play-sms-declaration.md section 7 in step with the disclosure the app really shows.
import { readFileSync } from 'fs';
import { join } from 'path';
import { DISCLOSURE_TITLE, disclosurePoints } from '../app/(setup)/permissions';
import { BACKFILL_OPTIONS } from '../src/state/setup';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }), Redirect: () => null, Stack: () => null }));

const doc = readFileSync(join(__dirname, '..', 'docs', 'play-sms-declaration.md'), 'utf8');
const section7 = doc.slice(doc.indexOf('## 7.'), doc.indexOf('## 8.'));

it('section 7 quotes the disclosure title and every point, for every period the user can choose', () => {
  expect(section7).toContain(DISCLOSURE_TITLE);
  for (const o of BACKFILL_OPTIONS) {
    for (const p of disclosurePoints(o.days)) expect(section7).toContain(p);
  }
});
