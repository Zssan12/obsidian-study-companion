import { expect, it } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import type { BackendEvent, BackendRequest, SourceContext, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';
const source: SourceContext = { sourcePath: 'Lesson.md', sourceName: 'Lesson', selectedText: 'Example source', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
async function setup() {
  let state: StudyState = { version: 1, units: [] }; const records: StudyRecord[] = []; const requests: BackendRequest[] = [];
  let id = 0; let failSave = false; let saveGate: Promise<void> | undefined; let held = false;
  const repository: StudyRepository = {
    async loadState() { return structuredClone(state); }, async saveState(next) { if (saveGate) await saveGate; if (failSave) throw new Error('disk offline'); state = structuredClone(next); },
    async listRecords() { return structuredClone(records); }, async createRecord(record) { records.push(structuredClone(record)); }, async updateStatus() {},
  };
  const create = () => new StudyController({ async *run(request): AsyncIterable<BackendEvent> {
    requests.push(request); yield { type: 'session', sessionId: `thread-${requests.length}` };
    if (held && !request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    yield { type: 'text', text: request.prompt.includes('MARKER_REMOVED') ? 'MARKER_REMOVED' : 'New answer' }; yield { type: 'done' };
  }, dispose() {} }, repository, () => `id-${++id}`, () => new Date(1800000000000 + id * 1000).toISOString());
  const app = create(); await app.initialize(); const unit = await app.startStudy(source);
  return { app, unit, records, requests, create, getState: () => state,
    fail: () => { failSave = true; }, gate: (gate: Promise<void>) => { saveGate = gate; }, hold: () => { held = true; } };
}
it('hides one main conversation, persists deletion and never resumes deleted backend memory', async () => {
  const f = await setup();
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'MARKER_REMOVED' });
  const before = structuredClone(f.records);
  await f.app.deleteConversation(f.records[0]!.id);
  expect(f.records).toEqual(before); // No record or file writes for deletion.
  expect(f.app.snapshot().records).toEqual([]);
  expect(f.app.snapshot().deletedConversations?.[0]?.records).toHaveLength(1);
  const reload = f.create(); await reload.initialize();
  expect(reload.snapshot().records).toEqual([]);
  await reload.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'New question', answerPolicy: 'direct' });
  expect(f.requests.at(-1)?.sessionId).toBeUndefined();
  expect(f.requests.at(-1)?.prompt).not.toContain('MARKER_REMOVED');
  expect(reload.snapshot().records).toHaveLength(1);
  await reload.restoreConversation(reload.snapshot().deletedConversations![0]!.id);
  expect(reload.snapshot().records).toHaveLength(2);
  await reload.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'Remember our earlier discussion', answerPolicy: 'direct' });
  expect(f.requests.at(-1)?.sessionId).toBeUndefined();
  expect(f.requests.at(-1)?.prompt).toContain('MARKER_REMOVED');
  expect(f.requests.at(-1)?.prompt).toContain('New question');
});
it('deleting Quick Ask leaves main and other Quick Ask alone; a stale popup cannot resume it', async () => {
  const f = await setup();
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'main' });
  const quick = await f.app.startQuick(f.unit.id, 'claude');
  await f.app.submit({ unitId: f.unit.id, kind: 'quick', conversationId: quick, context: source, question: 'first quick' });
  const q2 = await f.app.startQuick(f.unit.id, 'claude', true);
  await f.app.submit({ unitId: f.unit.id, kind: 'quick', conversationId: q2, context: source, question: 'other quick' });
  await f.app.deleteConversation(f.records[1]!.id);
  expect(f.app.snapshot().records.map(r => r.question)).toEqual(['main', 'other quick']);
  expect(await f.app.startQuick(f.unit.id, 'claude')).toBe(q2);
  await expect(f.app.submit({ unitId: f.unit.id, kind: 'quick', conversationId: quick, context: source, question: 'stale' })).rejects.toThrow('已移到已删除');
  await f.app.restoreConversation(f.app.snapshot().deletedConversations![0]!.id);
  await f.app.submit({ unitId: f.unit.id, kind: 'quick', conversationId: quick, context: source, question: 'restored' });
  expect(f.requests.at(-1)?.sessionId).toBeUndefined();
  expect(f.requests.at(-1)?.prompt).toContain('first quick');
  expect(f.requests.at(-1)?.prompt).not.toContain('other quick');
});
it('restores only Markdown records that still exist and uses user edits, not a cached body', async () => {
  const f = await setup();
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'one' });
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'two' });
  await f.app.deleteConversation(f.records[0]!.id); const deleted = f.app.snapshot().deletedConversations![0]!;
  f.records.splice(0, 1); f.records[0]!.answer = 'Edited on disk';
  await f.app.restoreConversation(deleted.id);
  expect(f.app.snapshot().records).toHaveLength(1);
  expect(f.app.snapshot().records[0]?.answer).toBe('Edited on disk');
});
it('failed state persistence keeps the conversation visible', async () => {
  const f = await setup(); await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'one' });
  f.fail(); await expect(f.app.deleteConversation(f.records[0]!.id)).rejects.toThrow('disk offline');
  expect(f.app.snapshot().records).toHaveLength(1);
  expect(f.app.snapshot().deletedConversations).toEqual([]);
});
it('blocks deletion during generation and blocks submits during a visibility mutation', async () => {
  const f = await setup(); await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'one' });
  let release!: () => void; f.gate(new Promise<void>(resolve => { release = resolve; }));
  const deletion = f.app.deleteConversation(f.records[0]!.id);
  await expect(f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'racing' })).rejects.toThrow('正在移到已删除');
  release(); await deletion;
  await f.app.restoreConversation(f.app.snapshot().deletedConversations![0]!.id);
  f.hold(); const pending = f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'running' });
  await expect(f.app.deleteConversation(f.records[0]!.id)).rejects.toThrow('正在回答');
  f.app.cancel(f.app.snapshot().running[0]!.requestId); await pending;
});

it('rejects a stale confirmation when the conversation gained another record', async () => {
  const f = await setup(); await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'one' });
  const ids = f.records.map(record => record.id);
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: source, question: 'two' });
  await expect(f.app.deleteConversation(ids[0]!, ids)).rejects.toThrow('核对更新后的列表');
  expect(f.app.snapshot().records).toHaveLength(2);
});
