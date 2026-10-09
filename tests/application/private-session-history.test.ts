import { expect, it, vi } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import type { BackendEvent, BackendRequest, SourceContext, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';

const source: SourceContext = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'Source A', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
async function setup() {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [], requests: BackendRequest[] = [];
  let serial = 0, threads = 0, failSave = false, failTurn = false, editDuringTurn = false;
  const alive = new Set<string>();
  const repo: StudyRepository = {
    async loadState() { return structuredClone(state); }, async saveState(next) { state = structuredClone(next); },
    async listRecords() { return structuredClone(records); },
    async createRecord(record) { if (failSave) throw new Error('disk failed'); records.push(structuredClone(record)); }, async updateStatus() {},
  };
  const backend = {
    hasSession: (id: string) => alive.has(id),
    async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
      requests.push(request);
      const id = request.sessionId ?? `thread-${++threads}`; alive.add(id);
      yield { type: 'session', sessionId: id };
      if (editDuringTurn) records[0]!.answer = 'EDITED_DURING_TURN';
      yield { type: 'text', text: `ANSWER_${requests.length}` };
      if (failTurn) { alive.delete(id); yield { type: 'error', message: 'interrupted' }; }
      else yield { type: 'done' };
    }, dispose() { alive.clear(); },
  };
  const create = () => new StudyController(backend, repo, () => `id-${++serial}`, () => new Date(1_800_000_000_000 + serial * 1000).toISOString(), () => 'codex');
  const app = create(); await app.initialize(); const unit = await app.startStudy(source);
  const submit = (question: string) => app.submit({ unitId: unit.id, kind: 'main', context: source, question, answerPolicy: 'direct' });
  return { app, unit, submit, records, requests, alive, create, repo, failSave: () => { failSave = true; }, failTurn: (value: boolean) => { failTurn = value; }, editDuringTurn: () => { editDuringTurn = true; } };
}
it('continues without replay, but rebuilds after a Markdown edit or physical removal', async () => {
  const f = await setup();
  await f.submit('REMOVED_QUESTION'); await f.submit('followup');
  expect(f.requests[1]!.sessionId).toBe('thread-1'); expect(f.requests[1]!.prompt).not.toContain('ANSWER_1');
  f.records[0]!.answer = 'USER_EDIT'; await f.submit('after edit');
  expect(f.requests[2]!.sessionId).toBeUndefined(); expect(f.requests[2]!.prompt).toContain('USER_EDIT'); expect(f.requests[2]!.prompt).not.toContain('ANSWER_1');
  f.records.splice(0, 1); await f.submit('after removal');
  expect(f.requests[3]!.sessionId).toBeUndefined(); expect(f.requests[3]!.prompt).not.toContain('REMOVED_QUESTION'); expect(f.requests[3]!.prompt).not.toContain('USER_EDIT');
});
it('rebuilds after delete and restore, then can continue the corrected private context', async () => {
  const f = await setup(); await f.submit('OLD_VISIBLE');
  await f.app.deleteConversation(f.records[0]!.id); await f.submit('NEW_VISIBLE');
  expect(f.requests[1]!.sessionId).toBeUndefined(); expect(f.requests[1]!.prompt).not.toContain('OLD_VISIBLE');
  await f.submit('next'); expect(f.requests[2]!.sessionId).toBe('thread-2');
  await f.app.restoreConversation(f.app.snapshot().deletedConversations![0]!.id); await f.submit('restored');
  expect(f.requests[3]!.sessionId).toBeUndefined(); expect(f.requests[3]!.prompt).toContain('OLD_VISIBLE');
  await f.submit('continued'); expect(f.requests[4]!.sessionId).toBe('thread-3');
});
it('recovers from plugin reload or evicted process using current Markdown with no failed model dispatch', async () => {
  const f = await setup(); await f.submit('REMEMBER_ME');
  f.alive.clear(); await f.submit('after eviction');
  expect(f.requests).toHaveLength(2); expect(f.requests[1]!.sessionId).toBeUndefined(); expect(f.requests[1]!.prompt).toContain('REMEMBER_ME');
  const reloaded = f.create(); await reloaded.initialize();
  await reloaded.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'after reload', answerPolicy: 'direct' });
  expect(f.requests[2]!.sessionId).toBeUndefined(); expect(f.requests[2]!.prompt).toContain('REMEMBER_ME');
});
it('does not checkpoint failed, unsaved or concurrently edited answers', async () => {
  const f = await setup(); await f.submit('complete'); f.failTurn(true); await f.submit('failed'); f.failTurn(false); await f.submit('retry');
  expect(f.requests[2]!.sessionId).toBeUndefined(); expect(f.requests[2]!.prompt).not.toContain('ANSWER_2');
  f.editDuringTurn(); await f.submit('mid-edit'); await f.submit('after mid-edit');
  expect(f.requests[4]!.sessionId).toBeUndefined(); expect(f.requests[4]!.prompt).toContain('EDITED_DURING_TURN');
  const unsaved = await setup(); unsaved.failSave(); await unsaved.submit('unsaved'); await unsaved.submit('next');
  expect(unsaved.requests[1]!.sessionId).toBeUndefined(); expect(unsaved.requests[1]!.prompt).not.toContain('ANSWER_1');
});
it('isolates Quick Ask, another source and explicit main reset', async () => {
  const f = await setup(); await f.submit('MAIN_SECRET');
  const quick = await f.app.startQuick(f.unit.id, 'codex');
  await f.app.submit({ unitId: f.unit.id, kind: 'quick', conversationId: quick, context: source, question: 'SIDE_SECRET' });
  expect(f.requests[1]!.sessionId).toBeUndefined(); expect(f.requests[1]!.prompt).not.toContain('MAIN_SECRET');
  await f.submit('main followup'); expect(f.requests[2]!.sessionId).toBe('thread-1'); expect(f.requests[2]!.prompt).not.toContain('SIDE_SECRET');
  const other = { ...source, sourcePath: 'B.md', sourceName: 'B', selectedText: 'Source B' }; const unit = await f.app.startStudy(other);
  await f.app.submit({ unitId: unit.id, kind: 'main', context: other, question: 'source B' });
  expect(f.requests[3]!.sessionId).toBeUndefined(); expect(f.requests[3]!.prompt).not.toContain('MAIN_SECRET');
  await f.app.resetMainSession(f.unit.id, 'codex'); await f.submit('fresh main');
  expect(f.requests[4]!.sessionId).toBeUndefined(); expect(f.requests[4]!.prompt).not.toContain('MAIN_SECRET');
});

function deferredRecords() {
  let resolve!: (records: StudyRecord[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<StudyRecord[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(['edit', 'remove'] as const)('waits for a superseding refresh before dispatch after a Markdown %s', async change => {
  const f = await setup(); await f.submit('OLD_QUESTION');
  if (change === 'edit') f.records[0]!.answer = 'EDITED_CONTENT';
  else f.records.splice(0, 1);
  const current = structuredClone(f.records);
  const older = deferredRecords(), latest = deferredRecords();
  vi.spyOn(f.repo, 'listRecords').mockImplementationOnce(() => older.promise).mockImplementationOnce(() => latest.promise);
  const submission = f.submit('after change');
  const background = f.app.refreshRecords();
  try {
    older.resolve(current);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.requests).toHaveLength(1);
    latest.resolve(current);
    await Promise.all([submission, background]);
    expect(f.requests[1]!.sessionId).toBeUndefined();
    expect(f.requests[1]!.prompt).not.toContain('ANSWER_1');
    if (change === 'edit') expect(f.requests[1]!.prompt).toContain('EDITED_CONTENT');
    else expect(f.requests[1]!.prompt).not.toContain('OLD_QUESTION');
    await f.submit('continue corrected conversation');
    expect(f.requests[2]!.sessionId).toBe('thread-2');
  } finally {
    latest.resolve(current);
    await Promise.all([submission, background]);
    await f.app.dispose();
  }
});

it('does not dispatch stale history if the superseding refresh fails', async () => {
  const f = await setup(); await f.submit('OLD_QUESTION');
  const older = deferredRecords(), latest = deferredRecords();
  vi.spyOn(f.repo, 'listRecords').mockImplementationOnce(() => older.promise).mockImplementationOnce(() => latest.promise);
  const submission = f.submit('after refresh failure');
  const background = f.app.refreshRecords().catch(error => error as Error);
  older.resolve([]);
  await new Promise(resolve => setTimeout(resolve, 0));
  latest.reject(new Error('Latest Markdown read failed'));
  await submission;
  expect(await background).toEqual(new Error('Latest Markdown read failed'));
  expect(f.requests).toHaveLength(1);
  expect(f.records.at(-1)).toMatchObject({ state: 'error', error: 'Latest Markdown read failed' });
  await f.app.dispose();
});
