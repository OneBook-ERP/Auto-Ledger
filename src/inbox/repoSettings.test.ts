import { createRepo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';

it('listSettings matches a literal prefix; deleteSetting removes one key', async () => {
  const repo = await createRepo(createTestDriver());
  await repo.setSetting('unrecognised_account:4321', '1');
  await repo.setSetting('unrecognised_account:9999', '2');
  await repo.setSetting('unrecognisedXaccount:1', '3'); // '_' must not act as a wildcard
  await repo.setSetting('unrecognised_count', '5');
  expect(await repo.listSettings('unrecognised_account:')).toEqual([
    { key: 'unrecognised_account:4321', value: '1' },
    { key: 'unrecognised_account:9999', value: '2' },
  ]);
  await repo.deleteSetting('unrecognised_account:4321');
  await repo.deleteSetting('missing');
  expect((await repo.listSettings('unrecognised_account:')).map((s) => s.key)).toEqual(['unrecognised_account:9999']);
  expect(await repo.getSetting('unrecognised_count')).toBe('5');
});

it('listQueuedTxnIds: txns with a pending outbox item, one query', async () => {
  const repo = await createRepo(createTestDriver());
  const plan = { steps: [], summary: [], needsInrAmount: false };
  const op = (id: string, txnId: string) => ({ id, txnId, plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' as const });
  await repo.enqueue(op('o1', 't1'));
  await repo.enqueue(op('o2', 't2'));
  await repo.enqueue(op('o3', 't2'));
  await repo.enqueue(op('o4', 't3'));
  await repo.markOutbox('o4', { status: 'done' });
  expect(await repo.listQueuedTxnIds()).toEqual(['t1', 't2']);
});
