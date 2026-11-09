import type { PendingTxn, Rule } from '../core/types';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { ErpNetworkError, ErpValidationError } from '../erp/client';
import { fakeInboxErp } from '../inbox/fakeErp';
import { BANK, CARD, NOW, txnFrom } from '../inbox/testData';
import { runPlan } from '../outbox/runner';
import { submitAnswer } from '../inbox/submit';
import { planAction } from '../core/plan';
import { undoTxn } from '../outbox/runner';
import {
  AUTO_FAILED_PREFIX, AUTO_HELD_PREFIX, AUTO_LIMIT, AUTO_NEW_COUNT_KEY, AUTO_SKIP_PREFIX, autoDoneKey, autoFailedKey, autoHeldKey, autoSinceKey, forgetRule, runAutoApply, switchAutomatic,
  type AutoApplyDeps,
} from './autoApply';
import { CHECKED_FROM_KEY, dupKey } from './dupCheck';
import { bringBack } from './statusPoller';
import { NEEDS_LOGIN_SINCE_KEY } from './drain';

const KEY = 'm:out:facebooksi';
const RULE: Rule = { matchKey: KEY, action: 'expense', account: 'Advertising - ZP', hits: 3, lastUsed: 1, auto: true, maxAmountMinor: 100_000, currency: 'INR' };
const base = txnFrom('idfc-035'); // card spend at FACEBOOK SI
const fb = (id: string, amountMinor = 50_000, over: Partial<PendingTxn> = {}): PendingTxn =>
  ({ ...base, id, rawHash: `h-${id}`, amountMinor, receivedAt: base.receivedAt + Number(id.replace(/\D/g, '') || 0), ...over });

async function setup(o: { txns?: PendingTxn[]; rules?: Rule[] } = {}) {
  const repo: Repo = await createRepo(createTestDriver());
  await repo.saveMapping(BANK);
  await repo.saveMapping(CARD);
  await repo.setSetting('company', 'ZP');
  await repo.setSetting('drawingsAccount', 'Drawings - ZP');
  for (const t of o.txns ?? []) await repo.upsertPending(t);
  for (const r of o.rules ?? [RULE]) await repo.saveRule(r);
  // Made automatic before the test items arrived (each test item is newer).
  for (const r of o.rules ?? [RULE]) if (r.auto) await repo.setSetting(autoSinceKey(r.matchKey), String(base.receivedAt - 1000));
  const erp = fakeInboxErp();
  const run = jest.fn(runPlan);
  const deps: AutoApplyDeps = { repo, erp, runPlan: run, now: () => NOW };
  return { repo, erp, run, deps };
}

const state = async (repo: Repo, id: string) => (await repo.getPending(id))?.state;
const rule = async (repo: Repo) => (await repo.listRules()).find((r) => r.matchKey === KEY);

describe('runAutoApply', () => {
  it('answers a new item matching an automatic rule, as a draft, and records it as done automatically', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1', 150_000)] });
    const r = await runAutoApply(deps);
    expect(r.done).toEqual(['f1']);
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    expect(await state(repo, 'f1')).toBe('created');
    expect(JSON.parse((await repo.getSetting(autoDoneKey('f1'))) ?? 'null')).toEqual({ at: NOW, docs: ['PE-1'] });
    expect(await repo.getSetting(AUTO_NEW_COUNT_KEY)).toBe('1');
    // Counted as a use, but an automatic answer never raises the largest confirmed amount.
    expect(await rule(repo)).toMatchObject({ hits: 4, maxAmountMinor: 100_000, auto: true });
  });

  it('leaves items the guard refuses in the Inbox: rule not automatic, possible duplicate, amount far above, other name, foreign amount', async () => {
    const other = { ...fb('f5'), merchant: 'FACEBOOKADS PVT' };
    const { repo, erp, deps } = await setup({ txns: [fb('f1'), fb('f2', 250_000), fb('f3', 50_000, { currency: 'USD' }), other] });
    await repo.setSetting(dupKey('f1'), JSON.stringify({ doctype: 'Journal Entry', name: 'JE-1', strength: 'weak', why: 'details' }));
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
    await repo.saveRule({ ...RULE, auto: false });
    await repo.deleteSetting(dupKey('f1'));
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
    expect(await state(repo, 'f1')).toBe('new');
  });

  it('at most 25 per run, one at a time; the rest wait for the next run', async () => {
    const txns = Array.from({ length: 30 }, (_, k) => fb(`f${k + 1}`, 1_000 + k));
    const { deps, run } = await setup({ txns });
    let active = 0; let peak = 0;
    run.mockImplementation(async (...a: Parameters<typeof runPlan>) => {
      active++; peak = Math.max(peak, active);
      try { await new Promise((res) => setTimeout(res, 0)); return await runPlan(...a); } finally { active--; }
    });
    expect(AUTO_LIMIT).toBe(25);
    expect((await runAutoApply(deps)).done).toHaveLength(25);
    expect(peak).toBe(1);
    expect((await runAutoApply(deps)).done).toHaveLength(5);
  });

  it('turning the rule off or deleting it stops the next run, and even the rest of a running one; drafts already made stay', async () => {
    const { repo, erp, deps, run } = await setup({ txns: [fb('f1', 50_000), fb('f2', 51_000), fb('f3', 52_000)] });
    run.mockImplementationOnce(async (...a: Parameters<typeof runPlan>) => {
      const out = await runPlan(...a);
      await repo.saveRule({ ...RULE, hits: 4, auto: false }); // the user switched it off meanwhile
      return out;
    });
    expect((await runAutoApply(deps)).done).toEqual(['f1']);
    expect(await state(repo, 'f1')).toBe('created');
    expect(await state(repo, 'f2')).toBe('new');
    expect(erp.deleteDraft).not.toHaveBeenCalled();
    await repo.saveRule({ ...RULE, auto: true });
    await forgetRule(repo, KEY);
    expect(await repo.getSetting(autoSinceKey(KEY))).toBeNull();
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(await state(repo, 'f1')).toBe('created');
  });

  it('a failed item is parked with its message and never retried by later runs; once the user answers it the note goes', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1', 50_000), fb('f2', 51_000)] });
    erp.createDraft.mockImplementationOnce(async () => {
      throw new ErpValidationError('Value missing for Journal Entry: Cost Center', 417, ['Cost Center']);
    });
    const r = await runAutoApply(deps);
    expect(r.failed).toEqual(['f1']);
    expect(r.done).toEqual(['f2']);
    expect(await repo.getSetting(autoFailedKey('f1'))).toContain('Cost Center');
    expect(await state(repo, 'f1')).toBe('new');
    erp.createDraft.mockClear();
    expect(await runAutoApply(deps)).toEqual({ done: [], failed: [], queued: [] });
    expect(erp.createDraft).not.toHaveBeenCalled();
    // The user answers it by hand: the note is cleared on the next run.
    await repo.upsertPending({ ...(await repo.getPending('f1'))!, state: 'created' });
    await runAutoApply(deps);
    expect(await repo.listSettings(AUTO_FAILED_PREFIX)).toEqual([]);
  });

  it('offline halfway: the answer is saved to send later and the run stops', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1', 50_000), fb('f2', 51_000)] });
    erp.createDraft.mockRejectedValue(new ErpNetworkError('offline'));
    const r = await runAutoApply(deps);
    expect(r).toEqual({ done: [], failed: [], queued: ['f1'] });
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    expect(await state(repo, 'f2')).toBe('new');
    expect(await repo.getSetting(autoFailedKey('f1'))).toBeNull();
  });

  it('signed out: nothing is written (the item just waits)', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1')] });
    await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, String(NOW));
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
    expect(await state(repo, 'f1')).toBe('new');
  });

  it('an item put back with Undo is never answered automatically again', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1')] });
    await runAutoApply(deps);
    await repo.upsertPending({ ...(await repo.getPending('f1'))!, state: 'new', createdDocs: [] }); // Undo
    erp.createDraft.mockClear();
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
    expect(await repo.getSetting(autoDoneKey('f1'))).toBeNull();
  });

  it('an item whose answer is already waiting to be sent is left alone', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1')] });
    jest.spyOn(repo, 'listQueuedTxnIds').mockResolvedValue(['f1']);
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { repo, deps } = await setup({ txns: [fb('f1')] });
    jest.spyOn(repo, 'listRules').mockRejectedValue(new Error('db'));
    await expect(runAutoApply(deps)).resolves.toEqual({ done: [], failed: [], queued: [] });
  });

  it('only items that arrived after the pattern became automatic: the old backlog (and anything left unticked) is never answered', async () => {
    const old = fb('f1');
    const { repo, erp, deps } = await setup({ txns: [old], rules: [{ ...RULE, auto: false }] });
    await switchAutomatic(repo, { ...RULE, auto: false }, true, old.receivedAt + 10);
    expect(await repo.getSetting(autoSinceKey(KEY))).toBe(String(old.receivedAt + 10));
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
    const newer = fb('f50', 51_000); // a different amount: the same one would be a look-alike of the backlog item
    await repo.upsertPending(newer);
    expect((await runAutoApply(deps)).done).toEqual(['f50']);
    expect(await state(repo, 'f1')).toBe('new');
    // Switched off and on again: the clock restarts.
    await switchAutomatic(repo, (await rule(repo))!, false, 0);
    expect(await repo.getSetting(autoSinceKey(KEY))).toBeNull();
  });

  it('a rule marked automatic without a start time never fires', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1')] });
    await repo.deleteSetting(autoSinceKey(KEY));
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
  });

  it('an item undone with the real Undo is never answered automatically again, even if the notes are lost', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1')] });
    expect((await runAutoApply(deps)).done).toEqual(['f1']);
    const doc = (await repo.getPending('f1'))!.createdDocs[0];
    erp.getDocStatuses.mockResolvedValue({ [`${doc.doctype}:${doc.name}`]: 0 });
    expect((await undoTxn('f1', { repo, erp })).status).toBe('undone');
    expect(await state(repo, 'f1')).toBe('new');
    for (const k of [autoDoneKey('f1'), `${AUTO_SKIP_PREFIX}f1`]) await repo.deleteSetting(k);
    erp.createDraft.mockClear();
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
  });

  it('an item brought back after an automatic Ignore is never ignored automatically again', async () => {
    const ignoreRule: Rule = { ...RULE, action: 'ignore', account: undefined };
    delete ignoreRule.account;
    const { repo, deps } = await setup({ txns: [fb('f1')], rules: [ignoreRule] });
    expect((await runAutoApply(deps)).done).toEqual(['f1']);
    expect(await state(repo, 'f1')).toBe('ignored');
    expect(await bringBack('f1', { repo })).toBe(true);
    for (const k of [autoDoneKey('f1'), `${AUTO_SKIP_PREFIX}f1`]) await repo.deleteSetting(k);
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(await state(repo, 'f1')).toBe('new');
  });

  it('an item whose own answer by the user failed is left to the user', async () => {
    const t = fb('f1');
    const { repo, erp, deps } = await setup({ txns: [t] });
    erp.createDraft.mockRejectedValueOnce(new ErpValidationError('Cost Center is mandatory', 417, ['Cost Center']));
    const choice = { type: 'expense' as const, expenseAccount: 'Travel - ZP' };
    const plan = planAction(t, choice, { company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-11-08', account: CARD });
    expect((await submitAnswer({ repo, erp, runPlan }, { txn: t, plan, choice, remember: false })).kind).toBe('error');
    expect(await state(repo, 'f1')).toBe('new');
    erp.createDraft.mockClear();
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
  });

  it('skips items older than the date the duplicate check could reach', async () => {
    const { repo, deps } = await setup({ txns: [fb('f1', 50_000, { occurredOn: '2026-11-01' }), fb('f2', 50_000, { occurredOn: '2026-11-07' })] });
    await repo.setSetting(CHECKED_FROM_KEY, '2026-11-05');
    expect((await runAutoApply(deps)).done).toEqual(['f2']);
    expect(await state(repo, 'f1')).toBe('new');
  });

  it('a rule whose answer does not fit how the money moved never fires (supplier payment on a card spend)', async () => {
    const sp: Rule = { matchKey: KEY, action: 'supplier_payment', party: { doctype: 'Supplier', name: 'Meta' }, hits: 2, lastUsed: 1, auto: true, maxAmountMinor: 100_000, currency: 'INR' };
    const { erp, deps } = await setup({ txns: [fb('f1')], rules: [sp] });
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
  });

  it('counting a use never brings back a rule deleted meanwhile, nor overwrites one the user changed', async () => {
    const a = await setup({ txns: [fb('f1')] });
    a.run.mockImplementationOnce(async (...x: Parameters<typeof runPlan>) => {
      const r = await runPlan(...x);
      await a.repo.deleteRule(KEY);
      return r;
    });
    expect((await runAutoApply(a.deps)).done).toEqual(['f1']);
    expect(await rule(a.repo)).toBeUndefined();

    const b = await setup({ txns: [fb('f1')] });
    const travel: Rule = { ...RULE, account: 'Travel - ZP', auto: false, hits: 9 };
    b.run.mockImplementationOnce(async (...x: Parameters<typeof runPlan>) => {
      const r = await runPlan(...x);
      await b.repo.saveRule(travel);
      return r;
    });
    expect((await runAutoApply(b.deps)).done).toEqual(['f1']);
    expect(await rule(b.repo)).toEqual(travel);
  });

  describe('look-alike payments (same name, same amount, within 3 days) are never automatic', () => {
    it('two identical items in one run: neither is answered, both wait with a note', async () => {
      const { repo, erp, deps } = await setup({ txns: [fb('f1'), fb('f2')] });
      expect(await runAutoApply(deps)).toEqual({ done: [], failed: [], queued: [] });
      expect(erp.createDraft).not.toHaveBeenCalled();
      expect(await state(repo, 'f1')).toBe('new');
      expect(await state(repo, 'f2')).toBe('new');
      expect(await repo.getSetting(autoHeldKey('f1'))).toBe('f2');
      expect(await repo.getSetting(autoHeldKey('f2'))).toBe('f1');
    });

    it('an item whose look-alike was answered automatically the day before is not answered', async () => {
      const { repo, erp, deps } = await setup({ txns: [fb('f1', 50_000, { occurredOn: '2026-11-07' })] });
      expect((await runAutoApply(deps)).done).toEqual(['f1']);
      erp.createDraft.mockClear();
      await repo.upsertPending(fb('f2', 50_000, { occurredOn: '2026-11-08' }));
      expect((await runAutoApply(deps)).done).toEqual([]);
      expect(erp.createDraft).not.toHaveBeenCalled();
      expect(await state(repo, 'f2')).toBe('new');
      expect(await repo.getSetting(autoHeldKey('f2'))).toBe('f1');
    });

    it('two different amounts, or the same amount far apart: both are answered', async () => {
      const a = await setup({ txns: [fb('f1', 50_000), fb('f2', 50_100)] });
      expect((await runAutoApply(a.deps)).done).toEqual(['f1', 'f2']);
      const b = await setup({ txns: [fb('f1', 50_000, { occurredOn: '2026-11-01' }), fb('f2', 50_000, { occurredOn: '2026-11-08' })] });
      expect((await runAutoApply(b.deps)).done).toEqual(['f1', 'f2']);
      expect(await b.repo.listSettings(AUTO_HELD_PREFIX)).toEqual([]);
    });

    it('the note goes once the item no longer waits', async () => {
      const { repo, deps } = await setup({ txns: [fb('f1'), fb('f2')] });
      await runAutoApply(deps);
      await repo.upsertPending({ ...(await repo.getPending('f1'))!, state: 'ignored' });
      await runAutoApply(deps);
      expect(await repo.getSetting(autoHeldKey('f1'))).toBeNull();
      expect(await repo.getSetting(autoHeldKey('f2'))).toBe('f1');
    });
  });

  it('signed out in the middle of a run: the rest of the batch stops at once', async () => {
    const { repo, erp, deps, run } = await setup({ txns: [fb('f1', 50_000), fb('f2', 51_000), fb('f3', 52_000)] });
    run.mockImplementationOnce(async (...a: Parameters<typeof runPlan>) => {
      const out = await runPlan(...a);
      await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, String(NOW));
      return out;
    });
    expect((await runAutoApply(deps)).done).toEqual(['f1']);
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    expect(await state(repo, 'f2')).toBe('new');
  });

  it('a rule with a party (Facebook card charge = expense for Meta) makes the Journal Entry draft with Meta on the expense line', async () => {
    const meta: Rule = { ...RULE, party: { doctype: 'Supplier', name: 'Meta' } };
    const { repo, erp, deps } = await setup({ txns: [fb('f1')], rules: [meta] });
    expect((await runAutoApply(deps)).done).toEqual(['f1']);
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    const [doctype, body] = erp.createDraft.mock.calls[0] as unknown as [string, { docstatus?: number; accounts: Record<string, unknown>[] }];
    expect(doctype).toBe('Journal Entry');
    expect(body.docstatus ?? 0).toBe(0);
    const [expense, card] = body.accounts;
    expect(expense).toMatchObject({ account: 'Advertising - ZP', party_type: 'Supplier', party: 'Meta', debit_in_account_currency: 500 });
    expect(card).toMatchObject({ account: CARD.glAccount, credit_in_account_currency: 500 });
    expect(card).not.toHaveProperty('party');
    expect(await state(repo, 'f1')).toBe('created');
  });
});

