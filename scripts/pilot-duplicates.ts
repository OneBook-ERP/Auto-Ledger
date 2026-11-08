/**
 * READ-ONLY, STAGE ONLY. Lists Payment Entry `reference_no` and Journal Entry `cheque_no` values used by more than one
 * non-cancelled document in a creation-date range, and drafts older than N days that are still docstatus 0.
 * Only HTTP GET is used. Exits with an error unless ONEBOOK_STAGE_URL is exactly https://stageatom.onebook.app.
 *
 *   ONEBOOK_STAGE_URL=https://stageatom.onebook.app ONEBOOK_STAGE_KEY=... ONEBOOK_STAGE_SECRET=... \
 *     npx tsx scripts/pilot-duplicates.ts --from 2026-11-10 --to 2026-11-12 [--draft-days 2]
 *
 * Credentials are read from the environment (for example `set -a; source .env.local; set +a`) and are never printed.
 * Exit code 1 when duplicates exist.
 */
import { assertStageUrl, groupDuplicates, staleDrafts, type DocRow } from './pilotDuplicates';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchRows(base: string, auth: string, doctype: DocRow['doctype'], field: string, from: string, to: string): Promise<DocRow[]> {
  const q = new URLSearchParams({
    fields: JSON.stringify(['name', field, 'docstatus', 'creation']),
    filters: JSON.stringify([['creation', 'between', [`${from} 00:00:00`, `${to} 23:59:59.999999`]]]),
    limit_page_length: '0',
    order_by: 'creation asc',
  });
  const res = await fetch(`${base}/api/resource/${encodeURIComponent(doctype)}?${q}`, { method: 'GET', headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${doctype}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown>[] };
  return (body.data ?? []).map((r) => ({
    doctype,
    name: String(r.name),
    reference: typeof r[field] === 'string' ? (r[field] as string) : null,
    docstatus: Number(r.docstatus),
    creation: String(r.creation),
  }));
}

async function main() {
  const base = assertStageUrl(process.env.ONEBOOK_STAGE_URL);
  const key = process.env.ONEBOOK_STAGE_KEY;
  const secret = process.env.ONEBOOK_STAGE_SECRET;
  if (!key || !secret) throw new Error('Set ONEBOOK_STAGE_KEY and ONEBOOK_STAGE_SECRET in the environment.');
  const from = arg('from');
  const to = arg('to');
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD [--draft-days N]');
  const days = Number(arg('draft-days') ?? '2');
  if (!Number.isFinite(days) || days < 0) throw new Error('--draft-days must be a number >= 0');
  const auth = `token ${key}:${secret}`;
  const rows = [
    ...(await fetchRows(base, auth, 'Payment Entry', 'reference_no', from, to)),
    ...(await fetchRows(base, auth, 'Journal Entry', 'cheque_no', from, to)),
  ];
  const dups = groupDuplicates(rows);
  const stale = staleDrafts(rows, new Date(), days);
  console.log(`site: ${base}  range: ${from}..${to}  documents examined: ${rows.length}`);
  console.log(`duplicate references: ${dups.length}`);
  for (const g of dups) console.log(`  ${g.reference}: ${g.docs.map((d) => `${d.doctype} ${d.name} (docstatus ${d.docstatus})`).join('; ')}`);
  console.log(`drafts older than ${days} day(s) still docstatus 0: ${stale.length}`);
  for (const r of stale) console.log(`  ${r.doctype} ${r.name} created ${r.creation} reference ${r.reference ?? '(none)'}`);
  process.exit(dups.length ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'failed');
  process.exit(2);
});
