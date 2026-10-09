import { expect, it, vi } from 'vitest';
import type { FilePort, StatePort, StudyBackend, StudyRecord, StudyState } from '../../src/core/contracts';
import { StudyController } from '../../src/application/StudyController';
import { JsonStudyRepository, type JsonHistoryPort } from '../../src/adapters/storage/JsonStudyRepository';
import { MarkdownStudyRepository } from '../../src/adapters/storage/MarkdownStudyRepository';
import { markdownLessonContext } from '../../src/core/markdown';
import { deriveLesson } from '../../src/application/lesson';

const context = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'source', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 6 } };
const record = (id = 'r1'): StudyRecord => ({ id, unitId: 'unit', conversationId: 'main:unit', kind: 'main',
  context, question: 'Why?', answer: 'Because.', createdAt: '2026-09-22T00:00:00Z', status: 'unresolved', state: 'complete' });

it('round-trips Markdown outlines, teaching snapshots and progress privately across reload', async () => {
  const f = fixture(); let sequence = 0; let answer = '## 1. 概念\n目标：理解概念。';
  const backend: StudyBackend = { async *run() { yield { type: 'text', text: answer }; yield { type: 'done' }; }, dispose() {} };
  const controller = new StudyController(backend, f.repository, () => 'md-' + ++sequence);
  await controller.initialize(); const source = markdownLessonContext(context, '# 概念\n原始内容', 'document');
  const unit = await controller.startStudy(source);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: '梳理', lesson: { kind: 'plan' } });
  expect(controller.snapshot().errors).toEqual([]);
  expect(controller.snapshot().records[0]?.context).toEqual(source);
  answer = '主题讲解';
  await controller.submit({ unitId: unit.id, kind: 'main', context: { ...context, selectedText: '' }, question: '继续' });
  const restored = new StudyController(backend, f.reload()); await restored.initialize();
  const snapshot = restored.snapshot(); const progress = deriveLesson(snapshot.units[0]!, snapshot.records);
  expect(progress?.completed).toHaveLength(1); expect(progress?.plan.context).toEqual(source);
  expect(snapshot.records.every(record => record.context.markdown?.scope === 'document')).toBe(true);
  expect(f.notes.size).toBe(0);
  await controller.dispose(); await restored.dispose();
});

function fixture() {
  // Memory ports exercise production codecs without touching user files.
  const notes = new Map<string, string>();
  const files: FilePort = {
    exists: async path => notes.has(path),
    read: async path => { if (!notes.has(path)) throw new Error('missing'); return notes.get(path)!; },
    create: async (path, text) => { if (notes.has(path)) throw new Error('exists'); notes.set(path, text); },
    process: async (path, transform) => { if (!notes.has(path)) throw new Error('missing'); notes.set(path, transform(notes.get(path)!)); },
    mkdir: vi.fn(async () => {}),
    listMarkdown: async () => [...notes.keys()],
  };
  let state: unknown; let data: unknown; let fail = false;
  const statePort: StatePort = { load: async () => state, save: async value => { state = structuredClone(value); } };
  const history: JsonHistoryPort = { path: '.obsidian/plugins/study-companion/history.json',
    read: async () => structuredClone(data),
    update: async transform => { if (fail) throw new Error('disk full'); data = structuredClone(transform(structuredClone(data))); },
  };
  const legacy = new MarkdownStudyRepository(files, statePort);
  const repository = new JsonStudyRepository(history, legacy);
  return { notes, files, legacy, repository, reload: () => new JsonStudyRepository(history, new MarkdownStudyRepository(files, statePort)),
    raw: () => data, setRaw: (value: unknown) => { data = value; }, failWrites: (value: boolean) => { fail = value; } };
}

it('saves main and Quick Ask exchanges without creating visible Markdown and restores both after reload', async () => {
  const f = fixture(); let sequence = 0;
  const backend: StudyBackend = { async *run() { yield { type: 'text', text: 'Local test answer' }; yield { type: 'done' }; }, dispose() {} };
  const controller = new StudyController(backend, f.repository, () => `id-${++sequence}`, () => '2026-09-22T00:00:00Z');
  await controller.initialize(); const unit = await controller.startStudy(context);
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: 'Main question' });
  const conversationId = await controller.startQuick(unit.id, 'claude');
  await controller.submit({ unitId: unit.id, kind: 'quick', conversationId, context, question: 'Side question' });
  const saved = controller.snapshot().records;
  expect(saved).toHaveLength(2); expect(saved.map(item => item.kind).sort()).toEqual(['main', 'quick']);
  expect(saved.every(item => item.state === 'complete' && item.answer === 'Local test answer')).toBe(true);
  expect(f.notes.size).toBe(0); expect(f.files.mkdir).not.toHaveBeenCalled();
  const resumed = new StudyController(backend, f.reload()); await resumed.initialize();
  expect(resumed.snapshot().records).toEqual(saved);
  expect(resumed.snapshot().units[0]?.quickConversation?.id).toBe(conversationId);
});

it('keeps existing Markdown readable and editable without copying it or creating more notes', async () => {
  const f = fixture(); await f.legacy.createRecord(record('old'));
  await f.repository.createRecord(record('new'));
  expect((await f.reload().listRecords()).map(item => item.id)).toEqual(['new', 'old']);
  await f.repository.updateCollection('old', { favorite: true });
  await f.repository.updateStatus('old', 'understood');
  expect((await f.reload().listRecords()).find(item => item.id === 'old')).toMatchObject({ favorite: true, status: 'understood' });
  const path = 'Study Companion/old.md';
  f.notes.set(path, f.notes.get(path)!.replace('Because.', 'Edited answer'));
  expect((await f.reload().listRecords()).find(item => item.id === 'old')?.answer).toBe('Edited answer');
  expect([...f.notes.keys()]).toEqual([path]);
  f.notes.delete(path);
  expect((await f.reload().listRecords()).map(item => item.id)).toEqual(['new']);
  await expect(f.repository.updateStatus('old', 'understood')).rejects.toThrow();
  expect(f.notes.size).toBe(0);
});

it('serializes simultaneous main/side saves and collection/status changes without losing data', async () => {
  const f = fixture();
  await Promise.all([f.repository.createRecord(record('one')), f.repository.createRecord(record('two'))]);
  await Promise.all([f.repository.updateStatus('one', 'understood'), f.repository.updateCollection('one', { favorite: true, tags: ['网络'] })]);
  expect(await f.reload().listRecords()).toEqual([
    { ...record('one'), status: 'understood', favorite: true, tags: ['网络'] }, record('two'),
  ]);
  expect(f.notes.size).toBe(0);
});

it('does not recreate private records removed from disk and uses current disk data when updating', async () => {
  const f = fixture(); await f.repository.createRecord(record());
  f.setRaw({ version: 1, records: [{ ...record(), answer: 'Changed externally', custom: 42 }], metadata: 'keep' });
  await f.repository.updateCollection('r1', { favorite: true });
  expect(f.raw()).toMatchObject({ metadata: 'keep', records: [{ answer: 'Changed externally', custom: 42, favorite: true }] });
  f.setRaw({ version: 1, records: [] });
  await expect(f.repository.updateCollection('r1', { favorite: false })).rejects.toThrow();
  expect(await f.repository.listRecords()).toEqual([]); expect(f.raw()).toEqual({ version: 1, records: [] });
});

it('rejects duplicate identities across JSON and legacy records', async () => {
  const f = fixture(); await f.repository.createRecord(record());
  await expect(f.repository.createRecord(record())).rejects.toThrow('already exists');
  await f.legacy.createRecord(record('old'));
  await expect(f.repository.createRecord(record('old'))).rejects.toThrow('already exists');
  expect((await f.repository.listRecords()).map(item => item.id)).toEqual(['r1', 'old']);
});

it.each([null, {}, { version: 2, records: [] }, { version: 1, records: 'bad' }])('never overwrites an invalid history envelope: %j', async bad => {
  const f = fixture(); f.setRaw(bad);
  await expect(f.repository.listRecords()).rejects.toThrow('格式无效');
  await expect(f.repository.createRecord(record())).rejects.toThrow('格式无效');
  expect(f.raw()).toEqual(bad);
});

it('skips individual malformed entries, reports their path and preserves them during unrelated writes', async () => {
  const f = fixture(); const malformed = { id: 'bad', question: 'Do not discard' };
  f.setRaw({ version: 1, records: [record(), malformed] });
  expect(await f.repository.listRecords()).toEqual([record()]);
  expect(f.repository.getDiagnostics()).toMatchObject([{ code: 'malformed-record', path: `${'.obsidian/plugins/study-companion/history.json'}#records[1]` }]);
  await expect(f.repository.updateStatus('bad', 'understood')).rejects.toThrow();
  await f.repository.createRecord(record('next'));
  expect(f.raw()).toEqual({ version: 1, records: [record(), malformed, record('next')] });
});

it('retains state ownership and reversible history deletion markers through the existing state port', async () => {
  const f = fixture();
  const state: StudyState = { version: 1, units: [{ id: 'unit', sourcePath: 'A.md', createdAt: 'now' }],
    deletedConversations: [{ id: 'delete', unitId: 'unit', kind: 'main', conversationId: 'main:unit', deletedAt: '2026-09-22T00:00:00Z', recordIds: ['r1'] }] };
  await f.repository.createRecord(record()); await f.repository.saveState(state);
  expect(await f.reload().loadState()).toEqual(state); expect(await f.reload().listRecords()).toEqual([record()]);
});

it('preserves data on write failure and allows a later explicit retry', async () => {
  const f = fixture(); await f.repository.createRecord(record()); f.failWrites(true);
  await expect(f.repository.createRecord(record('next'))).rejects.toThrow('disk full');
  expect(await f.repository.listRecords()).toEqual([record()]);
  f.failWrites(false); await f.repository.createRecord(record('next'));
  expect(await f.reload().listRecords()).toEqual([record(), record('next')]);
});

it('clears chat, preserves catalog, resets progress and excludes old context after reload', async () => {
  const f = fixture(); let sequence = 0; const requests: string[] = []; const sessions: (string | undefined)[] = [];
  let answer = ['## 1. 概念', '目标：理解概念。'].join(String.fromCharCode(10));
  const backend: StudyBackend = { async *run(request) { requests.push(request.prompt); sessions.push(request.sessionId); yield { type: 'session', sessionId: 'old-session' }; yield { type: 'text', text: answer }; yield { type: 'done', usage: { contextTokens: 10, contextWindow: 100 } }; }, dispose() {} };
  const app = new StudyController(backend, f.repository, () => 'clear-' + ++sequence);
  await app.initialize(); const source = markdownLessonContext(context, '概念与原始内容', 'document');
  const unit = await app.startStudy(source);
  await app.submit({ unitId: unit.id, kind: 'main', context: source, question: '梳理', lesson: { kind: 'plan' } });
  answer = 'SECRET_OLD_ANSWER';
  await app.submit({ unitId: unit.id, kind: 'main', context: source, question: '继续' });
  const ids = app.snapshot().records.map(record => record.id);
  expect(deriveLesson(app.snapshot().units[0]!, app.snapshot().records)?.completed).toHaveLength(1);
  await app.clearMainConversation(unit.id, ids);
  const reloaded = new StudyController(backend, f.reload(), () => 'next-' + ++sequence); await reloaded.initialize();
  expect(reloaded.snapshot().records).toEqual([]); expect(reloaded.snapshot().runtimes).toEqual([]);
  expect(deriveLesson(reloaded.snapshot().units[0]!, [])?.topics).toHaveLength(1);
  expect(deriveLesson(reloaded.snapshot().units[0]!, [])?.completed).toEqual([]);
  const removed = reloaded.snapshot().deletedConversations![0]!;
  answer = 'fresh';
  await reloaded.submit({ unitId: unit.id, kind: 'main', context, question: '新问题', answerPolicy: 'direct' });
  expect(requests.at(-1)).not.toContain('SECRET_OLD_ANSWER'); expect(sessions.at(-1)).toBeUndefined();
  await reloaded.permanentlyDeleteConversation(removed.id, ids);
  const final = new StudyController(backend, f.reload()); await final.initialize();
  expect(final.snapshot().deletedConversations).toEqual([]);
  expect(final.snapshot().records.map(record => record.answer)).toEqual(['fresh']);
  expect(JSON.stringify(f.raw())).not.toContain('SECRET_OLD_ANSWER');
  expect(deriveLesson(final.snapshot().units[0]!, final.snapshot().records)?.topics).toHaveLength(1);
  await expect(final.restoreConversation(removed.id)).rejects.toThrow();
});

it('purges only confirmed private records and protects stale edits, failed writes and legacy files', async () => {
  const f = fixture(); await f.repository.createRecord(record()); await f.repository.createRecord(record('other'));
  f.failWrites(true); await expect(f.repository.purgeRecords([record()])).rejects.toThrow('disk full');
  expect(await f.repository.listRecords()).toHaveLength(2); f.failWrites(false);
  await f.repository.updateCollection('r1', { favorite: true });
  await expect(f.repository.purgeRecords([record()])).rejects.toThrow('已改变');
  await f.legacy.createRecord(record('legacy')); const original = [...f.notes];
  await expect(f.repository.purgeRecords([record('legacy')])).rejects.toThrow('手动');
  expect([...f.notes]).toEqual(original);
  await f.repository.purgeRecords([record('other')]);
  expect((await f.reload().listRecords()).map(record => record.id)).toEqual(['r1', 'legacy']);
});

it('retains favorites on clear and permits unfavoriting before permanent removal', async () => {
  const f = fixture(); let sequence = 0;
  const backend: StudyBackend = { async *run() { yield { type: 'text', text: 'saved answer' }; yield { type: 'done' }; }, dispose() {} };
  const app = new StudyController(backend, f.repository, () => 'favorite-' + ++sequence);
  await app.initialize(); const unit = await app.startStudy(context);
  await app.submit({ unitId: unit.id, kind: 'main', context, question: 'question' });
  const id = app.snapshot().records[0]!.id;
  await app.setCollection(id, { favorite: true }); await app.clearMainConversation(unit.id, [id]);
  expect(app.snapshot().favoriteRecords?.map(record => record.id)).toEqual([id]);
  const removed = app.snapshot().deletedConversations![0]!;
  await expect(app.permanentlyDeleteConversation(removed.id, [id])).rejects.toThrow('收藏');
  await app.restoreConversation(removed.id); expect(app.snapshot().records).toHaveLength(1);
  await app.clearMainConversation(unit.id, [id]);
  await app.setCollection(id, { favorite: false });
  await app.permanentlyDeleteConversation(app.snapshot().deletedConversations![0]!.id, [id]);
  expect(await f.reload().listRecords()).toEqual([]);
});
