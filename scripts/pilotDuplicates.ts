// Pure helpers for scripts/pilot-duplicates.ts (read-only duplicate and stale-draft detection on STAGE).

export const STAGE_URL = 'https://stageatom.onebook.app';

/** Throws unless `url` is exactly the stage host. No trailing slash, no path, no other host. */
export function assertStageUrl(url: string | undefined): string {
  if (url !== STAGE_URL) {
    throw new Error(`ONEBOOK_STAGE_URL must be exactly ${STAGE_URL}; this script never runs against any other site.`);
  }
  return url;
}

export type DocRow = {
  doctype: 'Payment Entry' | 'Journal Entry';
  name: string;
  /** Payment Entry reference_no, or Journal Entry cheque_no. */
  reference: string | null;
  docstatus: number;
  creation: string;
};

export type DuplicateGroup = { reference: string; docs: { doctype: string; name: string; docstatus: number; creation: string }[] };

/** References used by more than one non-cancelled document (across both doctypes). Blank references are ignored. */
export function groupDuplicates(rows: readonly DocRow[]): DuplicateGroup[] {
  const by = new Map<string, DuplicateGroup>();
  for (const r of rows) {
    const ref = (r.reference ?? '').trim();
    if (!ref || r.docstatus === 2) continue;
    const g = by.get(ref) ?? { reference: ref, docs: [] };
    g.docs.push({ doctype: r.doctype, name: r.name, docstatus: r.docstatus, creation: r.creation });
    by.set(ref, g);
  }
  return [...by.values()].filter((g) => g.docs.length > 1).sort((a, b) => a.reference.localeCompare(b.reference));
}

/** Drafts (docstatus 0) created more than `days` days before `now`. `creation` is a Frappe timestamp `YYYY-MM-DD HH:mm:ss[.ffffff]`. */
export function staleDrafts(rows: readonly DocRow[], now: Date, days: number): DocRow[] {
  const cutoff = now.getTime() - days * 24 * 3600_000;
  return rows
    .filter((r) => {
      if (r.docstatus !== 0) return false;
      const t = Date.parse(r.creation.replace(' ', 'T') + 'Z'); // server time zone is not known here; the error is hours, not days
      return Number.isFinite(t) && t < cutoff;
    })
    .sort((a, b) => a.creation.localeCompare(b.creation));
}

/** The only request shape this tooling uses: GET, never following redirects (a redirect could carry the token elsewhere). */
export function readOnlyInit(auth: string): { method: 'GET'; redirect: 'error'; headers: Record<string, string> } {
  return { method: 'GET', redirect: 'error', headers: { Authorization: auth, Accept: 'application/json' } };
}
