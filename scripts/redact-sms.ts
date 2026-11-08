/**
 * Redacts a raw IDFC SMS export so it is safe to commit as test fixtures.
 *
 * CLI:  npx tsx scripts/redact-sms.ts <input.json> <output.json>
 *   input:  [[sender, receivedAtEpochMs, body], ...]   (kept OUTSIDE the repo)
 *   output: [{ sender, receivedAt, body }, ...]        (OTPs dropped, bodies redacted)
 *
 * Kept as-is: amounts, dates, times, balances, SMS wording, known merchant names, last 4 digits of
 * masked accounts/cards, public short codes. Replaced: names, digit runs of 6+ (consistent per run),
 * unique link/mandate tokens.
 */

export interface NameMap {
  people: Map<string, string>;
  companies: Map<string, string>;
  digits: Map<string, string>;
  tokens: Map<string, string>;
  rand: () => number;
}

/** Deterministic PRNG so fixture regeneration is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNameMap(seed = 20261108): NameMap {
  return {
    people: new Map(),
    companies: new Map(),
    digits: new Map(),
    tokens: new Map(),
    rand: mulberry32(seed),
  };
}

const COMPANY_WORDS =
  /\b(PRIVATE|PVT|LIMITED|LTD|LLP|LLC|INC|CORP|COMPANY|CO|TEXTILES?|EXPORTS?|ENTERPRISES?|TRADERS?|TRADING|INDUSTRIES|INDUSTRY|SOLUTIONS|SERVICES|SYSTEMS|TECHNOLOGIES|STUDIO|PRODUCTS|AGENCIES|FOODS|STORES?|BANK|LASERTECH|HOTEL|HOTELS|WORKS|ASSOCIATES|MOTORS|INFRA|VENTURES?)\b/i;

function normName(n: string): string {
  return n.replace(/\s+/g, ' ').trim().toUpperCase();
}

function placeholder(map: Map<string, string>, prefix: string, name: string): string {
  const key = normName(name);
  let v = map.get(key);
  if (!v) {
    v = `${prefix}_${map.size + 1}`;
    map.set(key, v);
  }
  return v;
}

function person(names: NameMap, n: string): string {
  return placeholder(names.people, 'PERSON', n);
}
function company(names: NameMap, n: string): string {
  return placeholder(names.companies, 'COMPANY', n);
}
/** Company-looking names become COMPANY_n, everything else PERSON_n. */
function party(names: NameMap, n: string): string {
  return COMPANY_WORDS.test(n) ? company(names, n) : person(names, n);
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function fakeToken(names: NameMap, tok: string): string {
  let v = names.tokens.get(tok);
  if (!v) {
    do {
      v = Array.from(tok, () => ALNUM[Math.floor(names.rand() * ALNUM.length)]).join('');
    } while (v === tok);
    names.tokens.set(tok, v);
  }
  return v;
}

/** Fake digit runs never exceed 8 digits, so the output can never contain a 9+ digit run. */
const MAX_FAKE_DIGITS = 8;

function fakeDigits(names: NameMap, run: string): string {
  let v = names.digits.get(run);
  if (!v) {
    const used = new Set(names.digits.values());
    const len = Math.min(run.length, MAX_FAKE_DIGITS);
    do {
      v = Array.from({ length: len }, (_, i) =>
        String(i === 0 ? 1 + Math.floor(names.rand() * 9) : Math.floor(names.rand() * 10)),
      ).join('');
    } while (v === run || used.has(v));
    names.digits.set(run, v);
  }
  return v;
}

/** Merchants that are real businesses and that parsers/rules depend on. */
const KNOWN_MERCHANT =
  /(FACEBOOK|GOOGLE|ANTHROPIC|ADOBE|AMAZON|CANVA|LINKEDIN|META|OPENAI|APOLLO|CLAUDE|CONTEXT ?AI)/i;

const PUBLIC_SHORT_CODES = new Set(['5676732']);
const GENERIC_DEAR = /^(Customer|Cardmember|Sir\/Ma'am|Sir|Madam)$/i;

export function redact(body: string, names: NameMap): string {
  let s = body;

  // Toll-free number: rewritten so that no 9-digit run remains anywhere.
  s = s.replace(/\b180010888\b/g, '1800 10 888');

  // --- names ---
  // Counterparty in long current-account SMS: "Info: NEFT/<ref>/<NAME>."
  s = s.replace(/(Info: ?[A-Za-z]+\/[^/\n]*\/)([^\n]+?)(\.?)(?=\n|$)/g, (_m, pre, name, dot) => {
    return `${pre}${party(names, name)}${dot}`;
  });
  // "Your beneficiary <NAME> has received" (the nameless variant has no name before "has")
  s = s.replace(/(beneficiary )(?!has )(.+?)( has received)/g, (_m, pre, name, post) => {
    return `${pre}${party(names, name)}${post}`;
  });
  // "Dear <NAME>," / "Dear MR. <NAME> :" (not Customer / Cardmember / Sir/Ma'am)
  s = s.replace(/(Dear |Hi )(?:M\/S\.? |MR\.? |MS\.? |MRS\.? )?([^,:\n]+?)(\s*[,:])/g, (m, pre, name, post) => {
    if (GENERIC_DEAR.test(name.trim()) || name.trim() === '') return m;
    const title = m.slice(pre.length).match(/^(M\/S\.? |MR\.? |MS\.? |MRS\.? )/)?.[1] ?? '';
    return `${pre}${title}${party(names, name)}${post}`;
  });
  // "<NAME> is added as a payee", "Success! <NAME> is added"
  s = s.replace(/(Dear Customer, |Success! )(.+?)( is added as a payee)/g, (_m, pre, name, post) => {
    return `${pre}${party(names, name)}${post}`;
  });
  // "Bulk transfer of <NAME>... for Rs."
  s = s.replace(/(Bulk transfer of )(.+?)( for Rs)/g, (_m, pre, name, post) => {
    return `${pre}${party(names, name)}${post}`;
  });
  // "received from <NAME>"
  s = s.replace(/((?:received|credited) from )([A-Z][A-Za-z .]+?)(?= on | via |\.|,)/g, (_m, pre, name) => {
    return `${pre}${party(names, name)}`;
  });
  // Card merchant: " at <MERCHANT> on dd MON yyyy" / " at <MERCHANT> declined" / "by <MERCHANT> on"
  const merchant = (name: string) => (KNOWN_MERCHANT.test(name) ? name : company(names, name));
  s = s.replace(/( spent on your [^.]*? at )(.+?)( on \d{2} [A-Z]{3} \d{4})/g, (_m, pre, name, post) => {
    return `${pre}${merchant(name)}${post}`;
  });
  s = s.replace(/( Credit Card XX\d{4} at )(.+?)( declined)/g, (_m, pre, name, post) => {
    return `${pre}${merchant(name)}${post}`;
  });
  s = s.replace(/( Credit Card XX\d{4} by )(.+?)( on \d{2} [A-Z]{3} \d{4})/g, (_m, pre, name, post) => {
    return `${pre}${merchant(name)}${post}`;
  });

  // --- tokens ---
  s = s.replace(/(https?:\/\/[\w.-]+\/(?:IDFCFB\/)?)([A-Za-z0-9_]{4,})/g, (_m, pre, tok) => {
    return `${pre}${fakeToken(names, tok)}`;
  });
  s = s.replace(/(SiHub ID:? |Mandate ID )([A-Za-z0-9]{6,})/g, (_m, pre, tok) => {
    return `${pre}${fakeToken(names, tok)}`;
  });

  // --- numbers ---
  // Masked account/card numbers with more than 4 digits: keep the last 4, 9-fill the rest.
  s = s.replace(/([Xx*]+)(\d{5,})/g, (_m, mask, digits) => {
    return `${mask}${'9'.repeat(digits.length - 4)}${digits.slice(-4)}`;
  });
  // Any other digit run of 6+ that is not an amount: consistent same-length fake.
  s = s.replace(/(?<![\d,.Xx*])\d{6,}(?!\d)/g, (run, offset: number, whole: string) => {
    const after = whole.slice(offset + run.length);
    const before = whole.slice(0, offset);
    if (/^\.\d/.test(after)) return run; // amount with decimals
    if (/(Rs\.?|INR|USD|EUR|GBP) ?-?$/i.test(before)) return run; // amount without decimals
    if (PUBLIC_SHORT_CODES.has(run)) return run;
    return fakeDigits(names, run);
  });
  // Final guard for masked numbers produced above or already 9-filled: nothing else to do.
  return s;
}

export function isOtp(body: string): boolean {
  return /\b(OTP|one[- ]time password|verification code)\b/i.test(body);
}

export interface RedactedMessage {
  sender: string;
  receivedAt: number;
  body: string;
}

export function redactMessages(
  raw: Array<[string, number, string]>,
  names: NameMap = createNameMap(),
): RedactedMessage[] {
  const out: RedactedMessage[] = [];
  for (const [sender, receivedAt, body] of raw) {
    if (isOtp(body)) continue;
    const red = redact(body, names);
    if (/\d{9,}/.test(red)) throw new Error(`digit run of 9+ survived redaction: ${red.slice(0, 80)}`);
    out.push({ sender, receivedAt, body: red });
  }
  return out;
}

function main(argv: string[]): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  const [input, output] = argv;
  if (!input || !output) {
    console.error('usage: tsx scripts/redact-sms.ts <input.json> <output.json>');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(input, 'utf8')) as Array<[string, number, string]>;
  const out = redactMessages(raw);
  fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
  console.log(`redacted ${out.length} of ${raw.length} messages (OTPs dropped) -> ${output}`);
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  main(process.argv.slice(2));
}
