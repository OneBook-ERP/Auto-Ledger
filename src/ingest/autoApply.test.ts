import type { PendingTxn, Rule } from '../core/types';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { ErpNetworkError, ErpValidationError } from '../erp/client';
import { fakeInboxErp } from '../inbox/fakeErp';
import { BANK, CARD, NOW, txnFrom } from '../inbox/testData';
import { runPlan } from '../outbox/runner';
import {
  AUTO_FAILED_PREFIX, AUTO_LIMIT, AUTO_NEW_COUNT_KEY, autoDoneKey, autoFailedKey, runAutoApply, type AutoApplyDeps,
} from './autoApply';
import { dupKey } from './dupCheck';
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
    expect(JSON.parse((await repo.getSetting(autoDoneKey('f1'))) ?? 'null')).toEqual({ at: NOW });
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
    const { repo, erp, deps, run } = await setup({ txns: [fb('f1'), fb('f2'), fb('f3')] });
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
    await repo.deleteRule(KEY);
    expect((await runAutoApply(deps)).done).toEqual([]);
    expect(await state(repo, 'f1')).toBe('created');
  });

  it('a failed item is parked with its message and never retried by later runs; once the user answers it the note goes', async () => {
    const { repo, erp, deps } = await setup({ txns: [fb('f1'), fb('f2')] });
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
    const { repo, erp, deps } = await setup({ txns: [fb('f1'), fb('f2')] });
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
});
