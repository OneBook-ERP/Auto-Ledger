/**
 * Spike B: ERPNext (v16) API behaviour on the STAGE site.
 * Run: npx tsx scripts/spike/erp-spike.ts
 *
 * Reads ONEBOOK_STAGE_URL / ONEBOOK_STAGE_KEY / ONEBOOK_STAGE_SECRET from .env.local.
 * Refuses to run against anything but stageatom.onebook.app. Never prints the key/secret.
 * Every document it creates is registered for cleanup and deleted in a finally block
 * (submitted docs are cancelled first). A final sweep reports anything left behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- env ----------
const env: Record<string, string> = {};
const envFile = path.resolve(__dirname, '../../.env.local');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const SITE = (env.ONEBOOK_STAGE_URL ?? '').replace(/\/+$/, '');
if (SITE !== 'https://stageatom.onebook.app') {
  throw new Error('Refusing to run: ONEBOOK_STAGE_URL must be https://stageatom.onebook.app');
}
const AUTH = `token ${env.ONEBOOK_STAGE_KEY}:${env.ONEBOOK_STAGE_SECRET}`;

const COMPANY = 'Zen Pivot Venture Studio Private Limited';
const BANK_GL = 'IDFC First - ZP';
const CARD_GL = 'IDFC Credit Card - ZP';
const EXPENSE_GL = 'Miscellaneous Expenses - ZP';
const COST_CENTER = 'Main - ZP';
const TODAY = new Date().toISOString().slice(0, 10);
const TAG = 'ZZSPIKE' + crypto.randomBytes(3).toString('hex').toUpperCase();

// ---------- http ----------
type Res = { status: number; body: any };
async function raw(
  method: string,
  p: string,
  opts: { body?: unknown; auth?: string | null; cookie?: string; form?: boolean } = {},
): Promise<Res & { headers: Headers }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const auth = opts.auth === undefined ? AUTH : opts.auth;
  if (auth) headers.Authorization = auth;
  if (opts.cookie) headers.Cookie = opts.cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(opts.body as Record<string, string>).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
  }
  const r = await fetch(SITE + p, { method, headers, body });
  const text = await r.text();
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    j = text.slice(0, 300);
  }
  return { status: r.status, body: j, headers: r.headers };
}
const qs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&');
const enc = encodeURIComponent;

/** Trim a Frappe error body: drop the python traceback ("exc"), parse _server_messages. */
function trimErr(b: any): any {
  if (!b || typeof b !== 'object') return b;
  const out: any = {};
  for (const k of Object.keys(b)) {
    if (k === 'exc') continue;
    if (k === '_server_messages') {
      try {
        out._server_messages = JSON.parse(b[k]).map((m: string) => {
          try {
            const o = JSON.parse(m);
            return { message: o.message, title: o.title, indicator: o.indicator };
          } catch {
            return m;
          }
        });
      } catch {
        out._server_messages = b[k];
      }
    } else out[k] = b[k];
  }
  return out;
}
const short = (x: unknown, n = 1200) => {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  return s.length > n ? s.slice(0, n) + '...' : s;
};

// ---------- cleanup registry ----------
type Cleanup = { doctype: string; name: string };
const created: Cleanup[] = [];
const track = (doctype: string, name: string) => created.push({ doctype, name });
const untrack = (doctype: string, name: string) => {
  const i = created.findIndex((c) => c.doctype === doctype && c.name === name);
  if (i >= 0) created.splice(i, 1);
};

async function insert(doctype: string, doc: Record<string, unknown>): Promise<Res> {
  const r = await raw('POST', `/api/resource/${enc(doctype)}`, { body: doc });
  if (r.status === 200 && r.body?.data?.name) track(doctype, r.body.data.name);
  return r;
}
async function destroy(doctype: string, name: string): Promise<Res> {
  const r = await raw('DELETE', `/api/resource/${enc(doctype)}/${enc(name)}`);
  if (r.status >= 200 && r.status < 300) untrack(doctype, name);
  return r;
}
async function docstatus(doctype: string, name: string): Promise<number | null> {
  const r = await raw('GET', `/api/resource/${enc(doctype)}/${enc(name)}?${qs({ fields: ['docstatus'] })}`);
  return r.status === 200 ? r.body.data.docstatus : null;
}
async function cancelAndDelete(doctype: string, name: string) {
  const ds = await docstatus(doctype, name);
  if (ds === null) return untrack(doctype, name);
  if (ds === 1) {
    await raw('POST', '/api/method/frappe.client.cancel', { body: { doctype, name } });
  }
  await destroy(doctype, name);
}
async function cleanupAll() {
  // reverse order; retry once because of link dependencies
  for (let pass = 0; pass < 3 && created.length; pass++) {
    for (const c of [...created].reverse()) {
      try {
        await cancelAndDelete(c.doctype, c.name);
      } catch (e) {
        console.log('  cleanup error', c, String(e));
      }
    }
  }
}

// ---------- reporting ----------
const results: { id: number; title: string; pass: boolean }[] = [];
function log(...a: unknown[]) {
  console.log(...a);
}
async function check(id: number, title: string, fn: () => Promise<boolean>) {
  log(`\n=== CHECK ${id}: ${title} ===`);
  let pass = false;
  try {
    pass = await fn();
  } catch (e: any) {
    log('  EXCEPTION', e?.message ?? e);
  }
  results.push({ id, title, pass });
  log(`[${pass ? 'PASS' : 'FAIL'}] ${id}. ${title}`);
}

// ---------- shared fixtures ----------
const CREATE_PI = process.argv.includes('--create-pi');
let customer = '';
let supplier = '';
let limitedKey = '';
const utr = (s: string) => `${TAG}-${s}`;
const BANK_MOP = 'Wire Transfer';
const CARD_MOP = 'Credit Card Bank Entry';
const ok2xx = (r: Res) => r.status >= 200 && r.status < 300;

/**
 * The pilot API user on stage cannot delete Customers, create Suppliers or Users (403, see check 9),
 * so the spike never creates parties: it reuses existing ones as references in drafts that are
 * deleted afterwards.
 */
async function pickParty(doctype: 'Customer' | 'Supplier', preferred: string): Promise<string> {
  const r = await raw('GET', `/api/resource/${doctype}?${qs({ filters: [['disabled', '=', 0]], fields: ['name'], limit_page_length: 50 })}`);
  const names: string[] = (r.body?.data ?? []).map((x: any) => x.name);
  if (!names.length) throw new Error(`no ${doctype} on stage`);
  return names.includes(preferred) ? preferred : names[0];
}

function payEntry(extra: Record<string, unknown>) {
  return { company: COMPANY, posting_date: TODAY, ...extra };
}
const brief = (d: any) => ({
  name: d.name, docstatus: d.docstatus, payment_type: d.payment_type, party_type: d.party_type, party: d.party,
  mode_of_payment: d.mode_of_payment, paid_from: d.paid_from, paid_to: d.paid_to, paid_amount: d.paid_amount,
  received_amount: d.received_amount, unallocated_amount: d.unallocated_amount, reference_no: d.reference_no,
  reference_date: d.reference_date, references: (d.references ?? []).map((x: any) => ({ t: x.reference_doctype, n: x.reference_name, alloc: x.allocated_amount })),
});

async function findBy(doctype: string, field: string, value: string) {
  return raw('GET', `/api/resource/${enc(doctype)}?${qs({ filters: [[field, '=', value]], fields: ['name', 'docstatus', field] })}`);
}
/** SUM over GL Entry; frappe v16 rejects "sum(x)" strings, needs dict syntax. */
async function glSums(account: string, upto: string) {
  return raw('GET', `/api/method/frappe.client.get_list?${qs({
    doctype: 'GL Entry',
    fields: [{ SUM: 'debit', as: 'debit' }, { SUM: 'credit', as: 'credit' }],
    filters: [['account', '=', account], ['company', '=', COMPANY], ['is_cancelled', '=', 0], ['posting_date', '<=', upto]],
  })}`);
}
async function sumOutstanding(doctype: string) {
  return raw('GET', `/api/method/frappe.client.get_list?${qs({
    doctype, fields: [{ SUM: 'outstanding_amount', as: 's' }],
    filters: [['docstatus', '=', 1], ['company', '=', COMPANY]],
  })}`);
}

// ---------- main ----------
async function main() {
  log(`Spike B on ${SITE}  tag=${TAG}  today=${TODAY}  create-pi=${CREATE_PI}`);
  customer = await pickParty('Customer', 'AFA Trading Company');
  supplier = await pickParty('Supplier', 'Bharti Airtel Limited');
  log(`fixtures (existing parties, read-only references): customer=${customer} supplier=${supplier}`);

  // 1 -------------------------------------------------------------
  await check(1, 'token auth: frappe.auth.get_logged_user', async () => {
    const good = await raw('GET', '/api/method/frappe.auth.get_logged_user');
    log('  valid token ->', good.status, short(good.body));
    const ver = await raw('GET', '/api/method/frappe.utils.change_log.get_versions');
    log('  versions ->', Object.entries(ver.body?.message ?? {}).map(([k, v]: any) => `${k}=${v.version}`).join(' '));
    return good.status === 200 && typeof good.body?.message === 'string';
  });

  // 2 -------------------------------------------------------------
  await check(2, 'login + generate_keys on throwaway users; api_key readable beforehand?', async () => {
    const mkUser = async (suffix: string, role: string) => {
      const email = `${TAG.toLowerCase()}${suffix}@example.com`;
      const password = 'Sp1ke!' + crypto.randomBytes(12).toString('base64url');
      const mk = await insert('User', {
        email, first_name: TAG + suffix, user_type: 'System User', send_welcome_email: 0, new_password: password,
        roles: [{ role }],
      });
      log(`  create throwaway user (${role}) ->`, mk.status, mk.status === 200 ? 'ok' : short(trimErr(mk.body)));
      return mk.status === 200 ? { email, password } : null;
    };
    const sessionLogin = async (email: string, password: string) => {
      const lg = await raw('POST', '/api/method/login', { auth: null, form: true, body: { usr: email, pwd: password } });
      const cookie = (((lg.headers as any).getSetCookie?.() as string[] | undefined) ?? []).map((c) => c.split(';')[0]).join('; ');
      return { lg, cookie };
    };
    const csrfOf = async (cookie: string) =>
      (await (await fetch(SITE + '/app', { headers: { Cookie: cookie } })).text()).match(/csrf_token\s*=\s*"([^"]+)"/)?.[1] ?? '';
    const sessionGenerateKeys = async (cookie: string, user: string, withCsrf = true) => {
      const csrf = withCsrf ? await csrfOf(cookie) : '';
      const r = await fetch(SITE + '/api/method/frappe.core.doctype.user.user.generate_keys', {
        method: 'POST',
        headers: { Cookie: cookie, ...(withCsrf ? { 'X-Frappe-CSRF-Token': csrf } : {}), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ user }).toString(),
      });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    const redact = (x: unknown) => short(x).replace(/("api_secret":")[^"]+/g, '$1<redacted>').replace(/("api_key":")[^"]+/g, '$1<redacted>');

    // pilot user's current roles (for the report)
    const pu = await raw('GET', '/api/resource/User/tools.zenpivot@gmail.com');
    log('  pilot user self-read ->', pu.status, 'roles:', (pu.body?.data?.roles ?? []).map((r: any) => r.role).join(', ') || '(not visible)', ' user_type:', pu.body?.data?.user_type, ' api_key present:', !!pu.body?.data?.api_key);

    // --- S: System Manager (full flow) ---
    const S = await mkUser('s', 'System Manager');
    if (!S) return false;
    const { lg, cookie } = await sessionLogin(S.email, S.password);
    log('  login ->', lg.status, short(lg.body), ' cookies:', cookie.split('; ').map((c) => c.split('=')[0]).join(','));
    const me = await raw('GET', '/api/method/frappe.auth.get_logged_user', { auth: null, cookie });
    log('  session get_logged_user ->', me.status, short(me.body));
    const before = await raw('GET', `/api/resource/User/${enc(S.email)}`, { auth: null, cookie });
    log('  self-read BEFORE generate_keys ->', before.status, 'api_key =', JSON.stringify(before.body?.data?.api_key ?? null), ' api_secret field present:', 'api_secret' in (before.body?.data ?? {}));
    log('  login response header names:', [...lg.headers.keys()].join(','));
    const gk0 = await sessionGenerateKeys(cookie, S.email, false);
    log('  generate_keys with session cookie but NO CSRF header ->', gk0.status, redact(trimErr(gk0.body)));
    const gk = await sessionGenerateKeys(cookie, S.email);
    log('  generate_keys (session + CSRF) ->', gk.status, 'response keys', Object.keys(gk.body.message ?? {}), 'body:', redact(gk.body));
    const key1: string | undefined = gk.body.message?.api_key;
    const sec1: string | undefined = gk.body.message?.api_secret;
    const afterSelf = await raw('GET', `/api/resource/User/${enc(S.email)}`, { auth: null, cookie });
    log('  self-read AFTER: api_key present', !!afterSelf.body?.data?.api_key, ' equals returned key', afterSelf.body?.data?.api_key === key1, ' api_secret exposed as:', JSON.stringify(afterSelf.body?.data?.api_secret ?? null).slice(0, 12));
    const use1 = await raw('GET', '/api/method/frappe.auth.get_logged_user', { auth: `token ${key1}:${sec1}` });
    log('  token auth with new key:secret ->', use1.status, short(use1.body));
    const gk2 = await sessionGenerateKeys(cookie, S.email);
    const key2 = gk2.body.message?.api_key;
    const sec2 = gk2.body.message?.api_secret;
    log('  second generate_keys: api_key unchanged =', key2 === key1, ' api_secret rotated =', !!sec2 && sec2 !== sec1);
    const old = await raw('GET', '/api/method/frappe.auth.get_logged_user', { auth: `token ${key1}:${sec1}` });
    const neu = await raw('GET', '/api/method/frappe.auth.get_logged_user', { auth: `token ${key2}:${sec2}` });
    log('  after rotation: old secret ->', old.status, '| new secret ->', neu.status);
    const wrong = await raw('POST', '/api/method/login', { auth: null, form: true, body: { usr: S.email, pwd: 'wrong-password-1' } });
    log('  login wrong password ->', wrong.status, short(trimErr(wrong.body)));

    // --- L: limited user (Employee only): can a non-System-Manager generate their own key? ---
    const L = await mkUser('l', 'Employee');
    if (L) {
      const l = await sessionLogin(L.email, L.password);
      log('  L login ->', l.lg.status, short(l.lg.body));
      const lgk = await sessionGenerateKeys(l.cookie, L.email);
      log('  L generate_keys for self (non-System-Manager) ->', lgk.status, redact(trimErr(lgk.body)));
      const lself = await raw('GET', `/api/resource/User/${enc(L.email)}`, { auth: null, cookie: l.cookie });
      log('  L self-read ->', lself.status, 'api_key =', JSON.stringify(lself.body?.data?.api_key ?? null));
      // give L a key via the admin to use for 401/403 probes later
      const adm = await raw('POST', '/api/method/frappe.core.doctype.user.user.generate_keys', { form: true, body: { user: L.email } });
      limitedKey = `token ${adm.body?.message?.api_key}:${adm.body?.message?.api_secret}`;
      log('  admin generate_keys for L ->', adm.status);
    }
    return use1.status === 200 && !!sec1 && old.status === 401 && neu.status === 200;
  });

  // 3 -------------------------------------------------------------
  await check(3, 'draft Payment Entry (Receive, Customer, unallocated) with reference_no; find by reference_no; delete', async () => {
    const ref = utr('PE1');
    const noMop = await insert('Payment Entry', payEntry({
      payment_type: 'Receive', party_type: 'Customer', party: customer, paid_to: BANK_GL,
      paid_amount: 1234.56, received_amount: 1234.56, reference_no: ref, reference_date: TODAY,
    }));
    log('  (a) without mode_of_payment ->', noMop.status, noMop.status === 200 ? 'accepted' : short(trimErr(noMop.body)));
    if (noMop.status === 200) await destroy('Payment Entry', noMop.body.data.name);

    const minimal = await insert('Payment Entry', payEntry({
      payment_type: 'Receive', party_type: 'Customer', party: customer, mode_of_payment: BANK_MOP, paid_to: BANK_GL,
      paid_amount: 1234.56, received_amount: 1234.56, reference_no: ref, reference_date: TODAY,
    }));
    log('  (b) mode_of_payment + paid_to only (no paid_from) ->', minimal.status, minimal.status === 200 ? '' : short(trimErr(minimal.body)));
    if (minimal.status !== 200) return false;
    const doc = minimal.body.data;
    log('  created:', short(brief(doc)));
    log('  server-filled: paid_from =', doc.paid_from, ' party_account_currency =', doc.party_account_currency, ' naming =', doc.name);
    const f = await findBy('Payment Entry', 'reference_no', ref);
    log('  find by reference_no ->', f.status, short(f.body));
    const found = f.body?.data?.length === 1 && f.body.data[0].name === doc.name;
    const del = await destroy('Payment Entry', doc.name);
    log('  delete draft ->', del.status, short(del.body));

    // (c) Receive against an existing open Sales Invoice, partial amount
    const si = await raw('GET', `/api/resource/Sales%20Invoice?${qs({ filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 5000], ['company', '=', COMPANY]], fields: ['name', 'customer', 'outstanding_amount'], limit_page_length: 1 })}`);
    const inv = si.body?.data?.[0];
    log('  (c) open Sales Invoice picked:', short(inv));
    let againstOk = true;
    if (inv) {
      const pe = await insert('Payment Entry', payEntry({
        payment_type: 'Receive', party_type: 'Customer', party: inv.customer, mode_of_payment: BANK_MOP, paid_to: BANK_GL,
        paid_amount: 1000, received_amount: 1000, reference_no: utr('PE1C'), reference_date: TODAY,
        references: [{ reference_doctype: 'Sales Invoice', reference_name: inv.name, allocated_amount: 1000 }],
      }));
      log('  (c) draft Receive vs Sales Invoice (partial 1000) ->', pe.status, pe.status === 200 ? short(brief(pe.body.data)) : short(trimErr(pe.body)));
      againstOk = pe.status === 200;
      if (pe.status === 200) log('  (c) SI outstanding unchanged while draft:', (await raw('GET', `/api/resource/Sales%20Invoice/${enc(inv.name)}`)).body?.data?.outstanding_amount, 'was', inv.outstanding_amount);
      if (pe.status === 200) await destroy('Payment Entry', pe.body.data.name);
    }
    return found && ok2xx(del) && againstOk;
  });

  // 4 -------------------------------------------------------------
  await check(4, 'draft Journal Entry with cheque_no = UTR (expense / card liability); find by cheque_no; delete', async () => {
    const ref = utr('JE1');
    const body = {
      company: COMPANY, posting_date: TODAY, voucher_type: 'Journal Entry', cheque_no: ref, cheque_date: TODAY, user_remark: 'spike',
      accounts: [
        { account: EXPENSE_GL, debit_in_account_currency: 500, cost_center: COST_CENTER },
        { account: CARD_GL, credit_in_account_currency: 500 },
      ],
    };
    const r = await insert('Journal Entry', body);
    log('  insert ->', r.status, r.status === 200 ? '' : short(trimErr(r.body)));
    if (r.status !== 200) return false;
    const d = r.body.data;
    log('  created:', short({ name: d.name, docstatus: d.docstatus, voucher_type: d.voucher_type, cheque_no: d.cheque_no, cheque_date: d.cheque_date, total_debit: d.total_debit, total_credit: d.total_credit, accounts: d.accounts.map((a: any) => ({ account: a.account, debit: a.debit_in_account_currency, credit: a.credit_in_account_currency, cost_center: a.cost_center })) }));
    const f = await findBy('Journal Entry', 'cheque_no', ref);
    log('  find by cheque_no ->', f.status, short(f.body));
    const found = f.body?.data?.length === 1 && f.body.data[0].name === d.name;
    const del = await destroy('Journal Entry', d.name);
    log('  delete draft ->', del.status, short(del.body));
    const nocc = await insert('Journal Entry', {
      company: COMPANY, posting_date: TODAY, voucher_type: 'Journal Entry', cheque_no: utr('JE1b'), cheque_date: TODAY,
      accounts: [{ account: EXPENSE_GL, debit_in_account_currency: 5 }, { account: CARD_GL, credit_in_account_currency: 5 }],
    });
    log('  insert without any cost_center ->', nocc.status, nocc.status === 200 ? `ok (rows default cost_center=${nocc.body.data.accounts.map((a: any) => a.cost_center)})` : short(trimErr(nocc.body)));
    if (nocc.status === 200) await destroy('Journal Entry', nocc.body.data.name);
    const cc = await insert('Journal Entry', { ...body, cheque_no: utr('JE1c'), voucher_type: 'Credit Card Entry' });
    log('  voucher_type "Credit Card Entry" ->', cc.status, cc.status === 200 ? 'ok' : short(trimErr(cc.body)));
    if (cc.status === 200) await destroy('Journal Entry', cc.body.data.name);
    return found && ok2xx(del);
  });

  // 5 -------------------------------------------------------------
  await check(5, 'Payment Entry (Pay, Supplier, vs Purchase Invoice) with paid_from = card liability account', async () => {
    // find an existing open PI; else (only with --create-pi) build one. NOTE: a submitted+cancelled PI cannot be
    // deleted afterwards via the API on this site (LinkExistsError on Payment Ledger Entry), so creation is opt-in.
    const open = await raw('GET', `/api/resource/Purchase%20Invoice?${qs({ filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0], ['company', '=', COMPANY]], fields: ['name', 'supplier', 'outstanding_amount'], limit_page_length: 1 })}`);
    let inv = open.body?.data?.[0] as { name: string; supplier: string; outstanding_amount: number } | undefined;
    log('  existing open Purchase Invoice:', short(inv ?? null));
    let builtPi = '';
    if (!inv && CREATE_PI) {
      const pi = await insert('Purchase Invoice', {
        company: COMPANY, supplier, posting_date: TODAY, bill_no: utr('BILL'), bill_date: TODAY, set_posting_time: 1,
        items: [{ item_code: 'Cloud Charges', qty: 1, rate: 1000, expense_account: EXPENSE_GL, cost_center: COST_CENTER }],
      });
      log('  create PI ->', pi.status, pi.status === 200 ? pi.body.data.name : short(trimErr(pi.body)));
      if (pi.status !== 200) return false;
      const sub = await raw('POST', '/api/method/frappe.client.submit', { body: { doc: pi.body.data } });
      log('  submit PI ->', sub.status, sub.status === 200 ? `docstatus=${sub.body.message.docstatus} outstanding=${sub.body.message.outstanding_amount}` : short(trimErr(sub.body)));
      if (sub.status !== 200) return false;
      builtPi = pi.body.data.name;
      inv = { name: builtPi, supplier, outstanding_amount: 1000 };
    }
    if (!inv) {
      log('  no open Purchase Invoice and --create-pi not given; testing unallocated Pay only');
    }
    const party = inv?.supplier ?? supplier;

    // (a) Pay, Supplier, unallocated, paid_from = card
    const adv = await insert('Payment Entry', payEntry({
      payment_type: 'Pay', party_type: 'Supplier', party, mode_of_payment: CARD_MOP, paid_from: CARD_GL, paid_to: 'Creditors - ZP',
      paid_amount: 321, received_amount: 321, reference_no: utr('PE2A'), reference_date: TODAY,
    }));
    log('  (a) Pay/Supplier unallocated, paid_from=card ->', adv.status, adv.status === 200 ? short(brief(adv.body.data)) : short(trimErr(adv.body)));
    if (adv.status === 200) await destroy('Payment Entry', adv.body.data.name);

    // (b) Pay vs the open PI
    let accepted = adv.status === 200;
    if (inv) {
      const amt = Math.min(1000, inv.outstanding_amount);
      const r = await insert('Payment Entry', payEntry({
        payment_type: 'Pay', party_type: 'Supplier', party, mode_of_payment: CARD_MOP, paid_from: CARD_GL, paid_to: 'Creditors - ZP',
        paid_amount: amt, received_amount: amt, reference_no: utr('PE2'), reference_date: TODAY,
        references: [{ reference_doctype: 'Purchase Invoice', reference_name: inv.name, allocated_amount: amt }],
      }));
      log('  (b) Pay vs Purchase Invoice, paid_from=card ->', r.status, r.status === 200 ? short(brief(r.body.data)) : short(trimErr(r.body)));
      accepted = r.status === 200;
      if (r.status === 200) {
        const f = await findBy('Payment Entry', 'reference_no', utr('PE2'));
        log('  found by reference_no:', short(f.body));
        await destroy('Payment Entry', r.body.data.name);
      } else {
        const je = await insert('Journal Entry', {
          company: COMPANY, posting_date: TODAY, voucher_type: 'Journal Entry', cheque_no: utr('JE2'), cheque_date: TODAY,
          accounts: [
            { account: 'Creditors - ZP', party_type: 'Supplier', party, debit_in_account_currency: amt, reference_type: 'Purchase Invoice', reference_name: inv.name },
            { account: CARD_GL, credit_in_account_currency: amt },
          ],
        });
        log('  (b-fallback) JE with party row + invoice reference ->', je.status, je.status === 200 ? 'accepted' : short(trimErr(je.body)));
        if (je.status === 200) await destroy('Journal Entry', je.body.data.name);
      }
      if (builtPi) {
        const c = await raw('POST', '/api/method/frappe.client.cancel', { body: { doctype: 'Purchase Invoice', name: builtPi } });
        log('  cancel built PI ->', c.status);
        const d = await destroy('Purchase Invoice', builtPi);
        log('  delete cancelled PI ->', d.status, d.status === 200 ? '' : short(trimErr(d.body), 300));
      }
    } else {
      const bad = await insert('Payment Entry', payEntry({
        payment_type: 'Pay', party_type: 'Supplier', party, mode_of_payment: CARD_MOP, paid_from: CARD_GL, paid_to: 'Creditors - ZP',
        paid_amount: 100, received_amount: 100, reference_no: utr('PE2X'), reference_date: TODAY,
        references: [{ reference_doctype: 'Purchase Invoice', reference_name: 'PINV-26-00001', allocated_amount: 100 }],
      }));
      log('  (b0) Pay vs an already-paid PI (expect reference validation error) ->', bad.status, short(trimErr(bad.body)));
      if (bad.status === 200) await destroy('Payment Entry', bad.body.data.name);
    }
    return accepted;
  });

  // 6 -------------------------------------------------------------
  await check(6, 'Internal Transfer Payment Entry IDFC First -> IDFC Credit Card', async () => {
    const noMop = await raw('POST', '/api/resource/Payment%20Entry', { body: payEntry({
      payment_type: 'Internal Transfer', paid_from: BANK_GL, paid_to: CARD_GL, paid_amount: 777, received_amount: 777,
      reference_no: utr('XFER0'), reference_date: TODAY,
    }) });
    log('  without mode_of_payment ->', noMop.status, noMop.status === 200 ? 'accepted' : short(trimErr(noMop.body)));
    if (noMop.status === 200) track('Payment Entry', noMop.body.data.name);
    const r = await insert('Payment Entry', payEntry({
      payment_type: 'Internal Transfer', mode_of_payment: BANK_MOP, paid_from: BANK_GL, paid_to: CARD_GL, paid_amount: 777, received_amount: 777,
      reference_no: utr('XFER'), reference_date: TODAY,
    }));
    log('  with mode_of_payment ->', r.status, r.status === 200 ? short(brief(r.body.data)) : short(trimErr(r.body)));
    if (r.status !== 200) return false;
    const f = await findBy('Payment Entry', 'reference_no', utr('XFER'));
    log('  find by reference_no ->', short(f.body));
    const del = await destroy('Payment Entry', r.body.data.name);
    return ok2xx(del) && f.body?.data?.length === 1;
  });

  // 7 -------------------------------------------------------------
  await check(7, 'frappe.desk.form.load.getdoctype (required + GST fields)', async () => {
    const r = await raw('GET', `/api/method/frappe.desk.form.load.getdoctype?${qs({ doctype: 'Customer', with_parent: 1 })}`);
    log('  Customer status', r.status, 'top-level keys', Object.keys(r.body ?? {}), 'docs', r.body?.docs?.length);
    const main = (r.body?.docs ?? []).find((d: any) => d.name === 'Customer');
    if (!main) return false;
    const fields: any[] = main.fields;
    const req = fields.filter((f) => f.reqd === 1);
    log('  Customer reqd=1:', short(req.map((f) => ({ fieldname: f.fieldname, label: f.label, fieldtype: f.fieldtype, default: f.default, options: f.options })), 1500));
    log('  Customer mandatory_depends_on:', short(fields.filter((f) => f.mandatory_depends_on).map((f) => [f.fieldname, f.mandatory_depends_on])));
    const gst = fields.filter((f) => /gst|^pan$/i.test(f.fieldname));
    log('  Customer GST/PAN fields:', short(gst.map((f) => ({ fieldname: f.fieldname, label: f.label, fieldtype: f.fieldtype, reqd: f.reqd, default: f.default })), 1000));
    for (const dt of ['Supplier', 'Employee', 'Payment Entry', 'Journal Entry']) {
      const x = await raw('GET', `/api/method/frappe.desk.form.load.getdoctype?${qs({ doctype: dt })}`);
      const m = (x.body?.docs ?? []).find((d: any) => d.name === dt);
      log(`  ${dt} status ${x.status} reqd=1:`, short((m?.fields ?? []).filter((f: any) => f.reqd === 1).map((f: any) => f.fieldname)), ' mandatory_depends_on:', short((m?.fields ?? []).filter((f: any) => f.mandatory_depends_on).map((f: any) => f.fieldname), 500));
    }
    return req.length > 0 && gst.length > 0;
  });

  // 8 -------------------------------------------------------------
  await check(8, 'AR/AP Summary via query_report.run and a bank/card balance return numbers', async () => {
    let ok = true;
    const totals: Record<string, number> = {};
    for (const report_name of ['Accounts Receivable Summary', 'Accounts Payable Summary']) {
      const r = await raw('POST', '/api/method/frappe.desk.query_report.run', {
        body: { report_name, filters: { company: COMPANY, report_date: TODAY, ageing_based_on: 'Due Date', range: '30, 60, 90, 120' }, ignore_prepared_report: true },
      });
      log(`  ${report_name} ->`, r.status);
      if (r.status !== 200) { log('   err', short(trimErr(r.body))); ok = false; continue; }
      const m = r.body.message;
      log('   message keys:', Object.keys(m).join(','));
      log('   columns:', short(m.columns.map((c: any) => c.fieldname), 600));
      const rows = m.result as any[];
      const dictRows = rows.filter((x) => x && !Array.isArray(x));
      const totalRow = rows.find((x) => Array.isArray(x));
      log('   rows:', rows.length, '(dict rows', dictRows.length, ', array total row:', !!totalRow, ')');
      log('   total row (array, positional):', short(totalRow));
      const idx = (f: string) => m.columns.findIndex((c: any) => c.fieldname === f);
      const out = Number(totalRow?.[idx('outstanding')]);
      const adv = Number(totalRow?.[idx('advance')]);
      const sumOut = dictRows.reduce((a, x) => a + (Number(x.outstanding) || 0), 0);
      log(`   total row: outstanding=${out} advance=${adv}; sum of dict rows outstanding=${sumOut}`);
      totals[report_name] = out;
      if (!Number.isFinite(out)) ok = false;
    }
    const si = await sumOutstanding('Sales Invoice');
    const pi = await sumOutstanding('Purchase Invoice');
    log('  naive SUM(outstanding_amount) Sales Invoice:', short(si.body?.message ?? trimErr(si.body)), ' vs AR report', totals['Accounts Receivable Summary']);
    log('  naive SUM(outstanding_amount) Purchase Invoice:', short(pi.body?.message ?? trimErr(pi.body)), ' vs AP report', totals['Accounts Payable Summary']);

    // spec 11: erpnext.accounts.utils.get_balance_on
    const gb = await raw('GET', `/api/method/erpnext.accounts.utils.get_balance_on?${qs({ account: BANK_GL, date: TODAY, company: COMPANY })}`);
    log('  erpnext.accounts.utils.get_balance_on ->', gb.status, short(trimErr(gb.body), 400));
    // alternatives
    const brt = await raw('GET', `/api/method/erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_account_balance?${qs({ bank_account: 'IDFC First - Zen Pivot - IDFC First', till_date: TODAY, company: COMPANY })}`);
    log('  bank_reconciliation_tool.get_account_balance ->', brt.status, short(brt.body), '(NOT the book balance: it is bank-statement-side, ~0 when reconciled)');
    const book: Record<string, number> = {};
    for (const a of [BANK_GL, CARD_GL, 'ICICI - ZP']) {
      const g = await glSums(a, TODAY);
      const row = g.body?.message?.[0];
      const bal = (Number(row?.debit) || 0) - (Number(row?.credit) || 0);
      book[a] = Math.round(bal * 100) / 100;
      log(`  GL sum ${a}: status ${g.status} debit=${row?.debit} credit=${row?.credit} => balance(debit-credit)=${book[a]}`);
      if (g.status !== 200 || !Number.isFinite(bal)) ok = false;
    }
    // cross-check against Trial Balance
    const tb = await raw('POST', '/api/method/frappe.desk.query_report.run', {
      body: { report_name: 'Trial Balance', filters: { company: COMPANY, fiscal_year: '2026-2027', from_date: '2026-04-01', to_date: TODAY, with_period_closing_entry_for_opening: 1, show_zero_values: 0 } },
    });
    const tbRow = (tb.body?.message?.result ?? []).find((x: any) => x?.account === BANK_GL);
    log('  Trial Balance row for', BANK_GL, '->', tb.status, short(tbRow && { opening_debit: tbRow.opening_debit, opening_credit: tbRow.opening_credit, debit: tbRow.debit, credit: tbRow.credit, closing_debit: tbRow.closing_debit, closing_credit: tbRow.closing_credit }));
    if (tbRow) log('  TB closing net (debit-credit) =', Math.round((tbRow.closing_debit - tbRow.closing_credit) * 100) / 100, ' vs GL-sum', book[BANK_GL]);
    return ok;
  });

  // 9 -------------------------------------------------------------
  await check(9, 'identifiable error payloads: missing required field, closed period, 401/403', async () => {
    // (a) mandatory-field errors
    const a1 = await raw('POST', '/api/resource/Payment%20Entry', { body: payEntry({ payment_type: 'Receive', party_type: 'Customer', party: customer, paid_to: BANK_GL, paid_amount: 1, received_amount: 1, reference_no: utr('MISS'), reference_date: TODAY }) });
    log('  (a1) Payment Entry without mode_of_payment ->', a1.status, short(trimErr(a1.body)));
    const a2 = await raw('POST', '/api/resource/Employee', { body: { first_name: TAG } });
    log('  (a2) Employee with only first_name ->', a2.status, short(trimErr(a2.body)));
    if (a2.status === 200) track('Employee', a2.body.data.name);
    const a3 = await raw('POST', '/api/resource/Customer', { body: { customer_type: 'Company' } });
    log('  (a3) Customer without customer_name ->', a3.status, short(trimErr(a3.body)));
    const a4 = await raw('POST', '/api/resource/Payment%20Entry', { body: { payment_type: 'Receive', company: COMPANY, posting_date: TODAY } });
    log('  (a4) Payment Entry without party_type ->', a4.status, short(trimErr(a4.body)));
    const missOk = a1.status === 417 && a1.body?.exc_type === 'MandatoryError';

    // (b) draft dated outside any fiscal year
    const fy = await insert('Journal Entry', { company: COMPANY, posting_date: '2020-01-15', voucher_type: 'Journal Entry', cheque_no: utr('FY'), cheque_date: '2020-01-15', accounts: [{ account: EXPENSE_GL, debit_in_account_currency: 1, cost_center: COST_CENTER }, { account: CARD_GL, credit_in_account_currency: 1 }] });
    log('  (b) draft JE dated 2020-01-15 (before any Fiscal Year) ->', fy.status, fy.status === 200 ? 'ACCEPTED as draft (no fiscal-year check at draft time)' : short(trimErr(fy.body)));
    if (fy.status === 200) await destroy('Journal Entry', fy.body.data.name);

    // (c) closed accounting period
    const ap = await insert('Accounting Period', {
      period_name: `${TAG} closed`, start_date: '2025-05-01', end_date: '2025-05-31', company: COMPANY,
      closed_documents: [{ document_type: 'Journal Entry', closed: 1 }, { document_type: 'Payment Entry', closed: 1 }],
    });
    log('  (c) create Accounting Period ->', ap.status, ap.status === 200 ? ap.body.data.name : short(trimErr(ap.body)));
    let closedSeen = false;
    if (ap.status === 200) {
      const je = await insert('Journal Entry', { company: COMPANY, posting_date: '2025-05-15', voucher_type: 'Journal Entry', cheque_no: utr('CLOSED'), cheque_date: '2025-05-15', accounts: [{ account: EXPENSE_GL, debit_in_account_currency: 1, cost_center: COST_CENTER }, { account: CARD_GL, credit_in_account_currency: 1 }] });
      log('  (c1) draft Journal Entry dated in closed period (insert) ->', je.status, je.status === 200 ? 'ACCEPTED as draft' : short(trimErr(je.body)));
      closedSeen = je.status === 417 && je.body?.exc_type === 'ClosedAccountingPeriod';
      if (je.status === 200) await destroy('Journal Entry', je.body.data.name);
      const pe = await insert('Payment Entry', payEntry({ payment_type: 'Receive', party_type: 'Customer', party: customer, mode_of_payment: BANK_MOP, posting_date: '2025-05-15', paid_to: BANK_GL, paid_amount: 1, received_amount: 1, reference_no: utr('CLOSEDPE'), reference_date: '2025-05-15' }));
      log('  (c2) draft Payment Entry dated in closed period (insert) ->', pe.status, pe.status === 200 ? 'ACCEPTED as draft' : short(trimErr(pe.body)));
      if (pe.status === 200) await destroy('Payment Entry', pe.body.data.name);
      const del = await destroy('Accounting Period', ap.body.data.name);
      log('  (c3) delete Accounting Period ->', del.status);
    }

    // (d) 401 / 403
    let perm403 = false;
    const bad = await raw('GET', '/api/method/frappe.auth.get_logged_user', { auth: 'token deadbeef:deadbeef' });
    log('  (d1) invalid api key:secret ->', bad.status, short(trimErr(bad.body)));
    const badSecret = await raw('GET', '/api/method/frappe.auth.get_logged_user', { auth: `token ${env.ONEBOOK_STAGE_KEY}:wrongsecret` });
    log('  (d2) right key, wrong secret ->', badSecret.status, short(trimErr(badSecret.body)));
    const none = await raw('GET', '/api/resource/Payment%20Entry?limit_page_length=1', { auth: null });
    log('  (d3) no Authorization header ->', none.status, short(trimErr(none.body)));
    if (limitedKey) {
      const sup = await raw('POST', '/api/resource/Supplier', { auth: limitedKey, body: { supplier_name: `${TAG} should-not-exist`, supplier_group: 'All Supplier Groups' } });
      log('  (d4) limited user POST Supplier ->', sup.status, short(trimErr(sup.body)));
      if (sup.status === 200) track('Supplier', sup.body.data.name);
      const wpe = await raw('POST', '/api/resource/Payment%20Entry', { auth: limitedKey, body: payEntry({ payment_type: 'Receive', party_type: 'Customer', party: customer, mode_of_payment: BANK_MOP, paid_to: BANK_GL, paid_amount: 1, received_amount: 1, reference_no: utr('L'), reference_date: TODAY }) });
      log('  (d5) limited user POST Payment Entry ->', wpe.status, short(trimErr(wpe.body)));
      if (wpe.status === 200) track('Payment Entry', wpe.body.data.name);
      const rpe = await raw('GET', '/api/resource/Payment%20Entry?limit_page_length=1', { auth: limitedKey });
      log('  (d6) limited user GET Payment Entry list ->', rpe.status, short(trimErr(rpe.body)));
      const rep = await raw('POST', '/api/method/frappe.desk.query_report.run', { auth: limitedKey, body: { report_name: 'Accounts Receivable Summary', filters: { company: COMPANY } } });
      log('  (d7) limited user query_report.run AR Summary ->', rep.status, short(trimErr(rep.body)));
      const gk = await raw('POST', '/api/method/frappe.core.doctype.user.user.generate_keys', { auth: limitedKey, body: { user: `no.such.${TAG.toLowerCase()}@example.com` } });
      log('  (d8) limited user generate_keys ->', gk.status, short(trimErr(gk.body)));
      perm403 = sup.status === 403 && wpe.status === 403;
    }
    const nw = await raw('GET', `/api/method/erpnext.accounts.utils.get_balance_on?${qs({ account: BANK_GL })}`);
    log('  (d9) non-whitelisted method (get_balance_on) ->', nw.status, short(trimErr(nw.body), 500));
    return missOk && closedSeen && bad.status === 401 && perm403;
  });
}

(async () => {
  try {
    await main();
  } catch (e) {
    console.log('FATAL', e);
  } finally {
    log('\n=== CLEANUP ===');
    await cleanupAll();
    log('  registry remaining (could not delete):', JSON.stringify(created));
    const sweeps: [string, string][] = [
      ['Customer', 'customer_name'], ['Supplier', 'supplier_name'], ['Payment Entry', 'reference_no'],
      ['Journal Entry', 'cheque_no'], ['Purchase Invoice', 'bill_no'], ['User', 'email'], ['Accounting Period', 'period_name'], ['Employee', 'first_name'],
    ];
    for (const [dt, f] of sweeps) {
      const r = await raw('GET', `/api/resource/${enc(dt)}?${qs({ filters: [[f, 'like', `${TAG}%`]], fields: ['name', 'docstatus'] })}`);
      log(`  sweep ${dt}.${f} like ${TAG}%:`, short(r.status === 200 ? r.body.data : trimErr(r.body), 300));
    }
    log('\n=== SUMMARY ===');
    for (const r of results) log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}. ${r.title}`);
  }
})();
