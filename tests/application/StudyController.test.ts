import { LearningTools } from '../../src/application/LearningTools';
import { describe, expect, it, vi } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import type { BackendEvent, BackendRequest, StudyBackend, StudyRecord, StudyRepository, StudyState, SourceContext, ReviewStatus } from '../../src/core/contracts';

const context = (sourcePath = 'A.md'): SourceContext => ({ sourcePath, sourceName: sourcePath, selectedText: '学习片段', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 4 } });
class MemoryRepository implements StudyRepository {
  state: StudyState = { version: 1, units: [] };
  records: StudyRecord[] = [];
  failCreate = false;
  failList = false;
  failSave = false;
  saveGate?: Promise<void>;
  saveStarted?: () => void;
  async loadState() { return structuredClone(this.state); }
  async saveState(state: StudyState) {
    if (this.failSave) throw new Error('state save failed');
    this.saveStarted?.();
    if (this.saveGate) await this.saveGate;
    this.state = structuredClone(state);
  }
  async listRecords() {
    if (this.failList) throw new Error('read failed');
    return structuredClone(this.records);
  }
  async createRecord(record: StudyRecord) {
    if (this.failCreate) throw new Error('disk full');
    this.records.push(structuredClone(record));
  }
  async updateStatus(id: string, status: ReviewStatus) {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('记录已不存在');
    record.status = status;
  }
}
class Backend implements StudyBackend {
  requests: BackendRequest[] = [];
  held?: Promise<void>;
  throwMessage?: string;
  omitDone = false;
  async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
    this.requests.push(request);
    yield { type: 'session', sessionId: request.sessionId ?? `session-${this.requests.length}` };
    if (this.held) await Promise.race([this.held, new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))]);
    if (request.signal.aborted) return;
    yield { type: 'text', text: '解释' };
    if (this.throwMessage) throw new Error(this.throwMessage);
    if (!this.omitDone) yield { type: 'done' };
  }
  dispose() { /* Fake has no resources. */ }
}
async function setup() {
  const backend = new Backend(); const repository = new MemoryRepository();
  let next = 0;
  const app = new StudyController(backend, repository, () => `id-${++next}`, () => '2026-09-10T12:00:00.000Z');
  await app.initialize();
  return { app, backend, repository };
}

describe('StudyController routing and persistence', () => {
  it.each(['main', 'quick'] as const)('sends real image payloads in %s while persisting only references', async kind => {
    const backend = new Backend(); const repository = new MemoryRepository();
    const image = { data: 'iVBORw0KGgoAAA==', mimeType: 'image/png' as const, label: 'diagram.png' };
    const read = vi.fn(async () => image);
    const app = new StudyController(backend, repository, undefined, undefined, undefined, undefined, undefined, undefined, read);
    await app.initialize(); const unit = await app.startStudy(context());
    const attachment = { ...context('Study Companion Attachments/diagram.png'), image: { sha256: 'a'.repeat(64) } };
    const conversationId = kind === 'quick' ? await app.startQuick(unit.id, 'claude') : undefined;
    await app.submit({ unitId: unit.id, context: context(), kind, conversationId, question: 'Explain image', attachments: [attachment] });
    expect(read).toHaveBeenCalledWith(attachment);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]!.images).toEqual([image]);
    expect(repository.records[0]!.attachments).toEqual([attachment]);
    expect(JSON.stringify(repository.records)).not.toContain(image.data);
  });
  it('does not call the backend when an image has changed or is unavailable', async () => {
    const backend = new Backend(); const repository = new MemoryRepository();
    const app = new StudyController(backend, repository, undefined, undefined, undefined, undefined, undefined, undefined,
      async () => { throw new Error('图片已改变'); });
    await app.initialize(); const unit = await app.startStudy(context());
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'Explain image', attachments: [{ ...context('image.png'), image: { sha256: 'a'.repeat(64) } }] });
    expect(backend.requests).toHaveLength(0);
    expect(app.snapshot().errors[0]?.message).toContain('图片已改变');
  });
  it('reuses a durable side session after reload and creates a different one only on explicit new', async () => {
    const { app, backend, repository } = await setup();
    const unit = await app.startStudy(context());
    const conversationId = await app.startQuick(unit.id, 'claude');
    const concurrent = await Promise.all([app.startQuick(unit.id, 'claude'), app.startQuick(unit.id, 'claude')]);
    expect(concurrent).toEqual([conversationId, conversationId]);
    await app.submit({ unitId: unit.id, kind: 'quick', conversationId, context: context(), question: 'First' });
    let id = 100;
    const resumed = new StudyController(backend, repository, () => `reload-${++id}`);
    await resumed.initialize();
    expect(await resumed.startQuick(unit.id, 'codex')).toBe(conversationId);
    await resumed.submit({ unitId: unit.id, kind: 'quick', conversationId, context: context(), question: 'Second' });
    expect(backend.requests[1]?.sessionId).toBe(backend.requests[0]?.sessionId ?? 'session-1');
    expect(repository.state.units[0]?.mainSessionId).toBeUndefined();
    const fresh = await resumed.startQuick(unit.id, 'codex', true);
    expect(fresh).not.toBe(conversationId);
    expect(repository.records).toHaveLength(2);
    expect(repository.state.units[0]?.quickConversation).toEqual({ id: fresh, provider: 'codex' });
  });

  it('continues the selected answer in its captured conversation without marking mastery', async () => {
    const { app, backend, repository } = await setup();
    const unit = await app.startStudy(context());
    const conversationId = await app.startQuick(unit.id, 'claude');
    await app.submit({ unitId: unit.id, kind: 'quick', conversationId, context: context(), question: 'Original question' });
    await app.startStudy(context('B.md'));
    await app.explainAgain(repository.records[0]!.id, true);
    expect(repository.records[1]).toMatchObject({ unitId: unit.id, kind: 'quick', conversationId, status: 'unresolved', context: { sourcePath: 'A.md' } });
    expect(backend.requests[1]?.prompt).toContain('举一个具体例子');
    expect(backend.requests[1]?.prompt).toContain('Original question');
    expect(repository.records[1]?.lesson).toBeUndefined();
  });
  it('freezes explicit attachments without rebinding the main source', async () => {
    const { app, backend, repository } = await setup();
    const unit = await app.startStudy(context());
    const attachment = context('B.md');
    let finish!: () => void;
    backend.held = new Promise<void>(resolve => { finish = resolve; });
    const pending = app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'Compare', attachments: [attachment] });
    attachment.selectedText = 'changed after sending';
    finish(); await pending;
    expect(backend.requests[0]!.prompt).toContain('B.md');
    expect(backend.requests[0]!.prompt).not.toContain('changed after sending');
    expect(repository.records[0]).toMatchObject({ unitId: unit.id, context: { sourcePath: 'A.md' }, attachments: [{ sourcePath: 'B.md', selectedText: '学习片段' }] });
    expect(repository.state.units).toHaveLength(1);
  });
  it('rejects oversized explicit attachments before calling the backend', async () => {
    const { app, backend } = await setup(); const unit = await app.startStudy(context());
    const send = (attachments: SourceContext[]) => app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'Why', attachments });
    await expect(send(Array(4).fill(context()))).rejects.toThrow('3');
    await expect(send([{ ...context(), selectedText: 'x'.repeat(12001) }])).rejects.toThrow('12000');
    await expect(send(Array.from({ length: 3 }, () => ({ ...context(), selectedText: 'x'.repeat(9000) })))).rejects.toThrow('24000');
    expect(backend.requests).toHaveLength(0);
  });
  it('keeps normal and study main and Quick Ask sessions independent', async () => {
    const { app, backend, repository } = await setup();
    const study = await app.startStudy(context());
    const [normal, duplicate] = await Promise.all([app.startNormal(), app.startNormal()]);
    expect(normal.id).toBe(duplicate.id);
    expect(normal).toMatchObject({ mode: 'normal', sourcePath: '' });
    expect(app.snapshot().activeUnitId).toBe(study.id);
    app.setMode('normal');
    app.focusSource('A.md');
    expect(app.snapshot().activeUnitId).toBe(normal.id);
    const empty = { ...context(''), sourceName: '', selectedText: '' };
    await app.submit({ unitId: normal.id, context: empty, kind: 'main', question: 'Hello' });
    await app.submit({ unitId: study.id, context: context(), kind: 'main', question: 'Study' });
    await app.submit({ unitId: normal.id, context: context('Other.md'), kind: 'quick', conversationId: 'side', question: 'Normal quick' });
    await app.submit({ unitId: study.id, context: context(), kind: 'quick', conversationId: 'side', question: 'Study quick' });
    await app.submit({ unitId: normal.id, context: empty, kind: 'main', question: 'Continue' });
    await app.submit({ unitId: normal.id, context: context('Other.md'), kind: 'quick', conversationId: 'side', question: 'Continue quick' });
    expect(backend.requests.map(item => item.sessionId)).toEqual([undefined, undefined, undefined, undefined, 'session-1', 'session-3']);
    expect(repository.records[0]).toMatchObject({ mode: 'normal', context: { sourcePath: '' } });
    expect(backend.requests[0]?.prompt).toContain('普通对话');
    expect(backend.requests[1]?.prompt).toContain('当前资料');
    app.setMode('study');
    expect(app.snapshot().activeUnitId).toBe(study.id);
    await expect(app.submit({ unitId: normal.id, context: empty, kind: 'quick', question: 'No selection' })).rejects.toThrow('选择文字');
  });

  it('allows source-bound main questions without a quote while keeping Quick Ask and attachments explicit', async () => {
    const { app, backend, repository } = await setup();
    const empty = { ...context(), selectedText: '', before: '', after: '' };
    const unit = await app.startStudy(empty);
    await app.submit({ unitId: unit.id, kind: 'main', context: empty, question: 'A general question' });
    expect(repository.records[0]?.context.selectedText).toBe('');
    expect(backend.requests[0]?.prompt).toContain('路径不代表提供了文件内容');
    await expect(app.submit({ unitId: unit.id, kind: 'quick', context: empty, question: 'Side' })).rejects.toThrow('引用的文字');
    await expect(app.submit({ unitId: unit.id, kind: 'main', context: empty, attachments: [empty], question: 'Blank attachment' })).rejects.toThrow('引用的文字');
    expect(backend.requests).toHaveLength(1);
  });

  it('creates one stable unit for concurrent starts of the same file', async () => {
    const { app, repository } = await setup();
    const [a, b] = await Promise.all([app.startStudy(context()), app.startStudy(context())]);
    expect(a.id).toBe(b.id); expect(repository.state.units).toHaveLength(1);
  });

  it('does not let a delayed startStudy override a newer source focus', async () => {
    const backend = new Backend();
    const repository = new MemoryRepository();
    repository.state.units.push({ id: 'unit-b', sourcePath: 'B.md', createdAt: '2026-09-10T12:00:00.000Z' });
    const app = new StudyController(backend, repository, () => 'unit-a', () => '2026-09-10T12:00:00.000Z');
    await app.initialize();
    app.focusSource('B.md');
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const started = new Promise<void>(resolve => { saveStarted = resolve; });
    repository.saveStarted = saveStarted;
    repository.saveGate = new Promise<void>(resolve => { releaseSave = resolve; });

    const pending = app.startStudy(context());
    await started;
    // A repeated focus event still expresses a newer choice than the pending start.
    app.focusSource('B.md');
    releaseSave();
    const unit = await pending;

    expect(unit.id).toBe('unit-a');
    expect(app.snapshot().activeUnitId).toBe('unit-b');
  });

  it('does not let a delayed startNormal override a newer study selection', async () => {
    const { app, repository } = await setup();
    const study = await app.startStudy(context());
    app.setMode('normal');
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const started = new Promise<void>(resolve => { saveStarted = resolve; });
    repository.saveStarted = saveStarted;
    repository.saveGate = new Promise<void>(resolve => { releaseSave = resolve; });

    const pending = app.startNormal();
    await started;
    app.selectUnit(study.id);
    releaseSave();
    await pending;

    expect(app.snapshot()).toMatchObject({ mode: 'study', activeUnitId: study.id });
  });

  it('continues main by explicit ID while each Quick Ask starts independently', async () => {
    const { app, backend, repository } = await setup(); const unit = await app.startStudy(context());
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: '主线' });
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: '旁路', conversationId: 'side' });
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: '追问', conversationId: 'side' });
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: '继续主线' });
    expect(backend.requests.map(request => request.sessionId)).toEqual([undefined, undefined, 'session-2', 'session-1']);
    expect(repository.state.units[0]?.mainSessionId).toBe('session-1');
    expect(repository.records.map(record => record.kind)).toEqual(['main', 'quick', 'quick', 'main']);
  });

  it('keeps the original destination when active source changes mid-answer', async () => {
    const { app, backend, repository } = await setup();
    const a = await app.startStudy(context()); const b = await app.startStudy(context('B.md'));
    let release!: () => void; backend.held = new Promise<void>(resolve => { release = resolve; });
    const pending = app.submit({ unitId: a.id, context: context(), kind: 'main', question: 'A 的问题' });
    app.focusSource('B.md');
    expect(app.snapshot().running[0]?.unitId).toBe(a.id);
    release(); await pending;
    expect(app.snapshot().activeUnitId).toBe(b.id);
    expect(repository.records[0]?.unitId).toBe(a.id);
    expect(repository.state.units.find(unit => unit.id === b.id)?.mainSessionId).toBeUndefined();
  });

  it('rejects duplicate main requests and a second global Quick Ask', async () => {
    const { app, backend } = await setup(); const a = await app.startStudy(context());
    backend.held = new Promise<void>(() => undefined);
    const main = app.submit({ unitId: a.id, context: context(), kind: 'main', question: 'one' });
    await expect(app.submit({ unitId: a.id, context: context(), kind: 'main', question: 'two' })).rejects.toThrow('正在回答');
    const side = app.submit({ unitId: a.id, context: context(), kind: 'quick', question: 'side' });
    await expect(app.submit({ unitId: a.id, context: context(), kind: 'quick', question: 'another' })).rejects.toThrow('另一条旁路');
    for (const run of app.snapshot().running) app.cancel(run.requestId);
    await Promise.all([main, side]);
  });

  it('preserves partial output and marks an interrupted stream as error', async () => {
    const { app, backend, repository } = await setup(); const unit = await app.startStudy(context());
    backend.throwMessage = 'network failed';
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: '问题' });
    expect(repository.records[0]).toMatchObject({ answer: '解释', state: 'error', error: 'network failed', sessionId: 'session-1' });
    expect(app.snapshot().running).toHaveLength(0);
  });

  it('does not mark a truncated stream complete', async () => {
    const { app, backend, repository } = await setup(); const unit = await app.startStudy(context()); backend.omitDone = true;
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: '问题' });
    expect(repository.records[0]?.state).toBe('error');
    expect(app.snapshot().errors).toContainEqual(expect.objectContaining({
      unitId: unit.id,
      kind: 'main',
      conversationId: `main:${unit.id}`,
      message: expect.stringContaining('提前结束'),
    }));
  });

  it('persists cancellation without retrying', async () => {
    const { app, backend, repository } = await setup(); const unit = await app.startStudy(context());
    backend.held = new Promise<void>(() => undefined);
    const pending = app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: '问题' });
    app.cancel(app.snapshot().running[0]!.requestId);
    await pending;
    expect(repository.records[0]?.state).toBe('cancelled'); expect(backend.requests).toHaveLength(1);
  });

  it('persists rename identity while preserving historical source text', async () => {
    const { app, repository } = await setup(); const unit = await app.startStudy(context());
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: '问题' });
    await app.renameSource('A.md', 'Folder/Renamed.md');
    expect(repository.state.units[0]).toMatchObject({ id: unit.id, sourcePath: 'Folder/Renamed.md', mainSessionId: 'session-1' });
    expect(repository.records[0]?.context.sourcePath).toBe('A.md');
    await expect(app.submit({ unitId: unit.id, context: context(), kind: 'main', question: '旧选区' })).rejects.toThrow('不一致');
  });

  it('does not recreate deleted records when status is changed', async () => {
    const { app, repository } = await setup(); const unit = await app.startStudy(context());
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: '问题' });
    const id = repository.records[0]!.id;
    repository.records = [];
    await expect(app.markRecord(id, 'understood')).rejects.toThrow('不存在');
    await app.refreshRecords(); expect(app.snapshot().records).toEqual([]);
  });

  it('keeps an unsaved answer visible and reports the storage failure', async () => {
    const { app, repository } = await setup(); const unit = await app.startStudy(context()); repository.failCreate = true;
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: '问题' });
    expect(app.snapshot().records[0]?.answer).toBe('解释');
    expect(app.snapshot().records[0]?.provider).toBe('claude');
    expect(app.snapshot().errors).toContainEqual(expect.objectContaining({
      unitId: unit.id,
      kind: 'quick',
      message: expect.stringContaining('保存失败'),
    })); expect(repository.records).toEqual([]);
    await app.refreshRecords();
    expect(app.snapshot().records[0]?.answer).toBe('解释');
  });

  it('does not resurrect a saved record deleted after a failed refresh', async () => {
    const { app, repository } = await setup(); const unit = await app.startStudy(context());
    repository.failList = true;
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'question' });
    expect(repository.records).toHaveLength(1);
    expect(app.snapshot().records[0]?.answer).toBe('解释');
    expect(app.snapshot().errors[0]?.message).toContain('已保存，但刷新失败');
    repository.records = [];
    repository.failList = false;
    await app.refreshRecords();
    expect(app.snapshot().records).toEqual([]);
  });

  it('restores mapped main and side sessions after controller restart', async () => {
    const { app, backend, repository } = await setup(); const unit = await app.startStudy(context());
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'main' });
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', conversationId: 'side', question: 'side' });
    const restored = new StudyController(backend, repository); await restored.initialize();
    await restored.submit({ unitId: unit.id, context: context(), kind: 'quick', conversationId: 'side', question: 'again' });
    expect(backend.requests[2]?.sessionId).toBe('session-2');
    await restored.resetMainSession(unit.id);
    await restored.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'new main' });
    expect(backend.requests[3]?.sessionId).toBeUndefined(); expect(repository.records).toHaveLength(4);
  });

  it('keeps errors scoped when different units finish independently', async () => {
    const { app, backend } = await setup();
    const a = await app.startStudy(context()); const b = await app.startStudy(context('B.md'));
    backend.throwMessage = 'concurrent failure';
    let release!: () => void;
    backend.held = new Promise<void>(resolve => { release = resolve; });
    const first = app.submit({ unitId: a.id, context: context(), kind: 'main', question: 'A' });
    const second = app.submit({ unitId: b.id, context: context('B.md'), kind: 'main', question: 'B' });
    expect(app.snapshot().running).toHaveLength(2);
    release();
    await Promise.all([first, second]);
    expect(app.snapshot().errors).toHaveLength(2);
    expect(app.snapshot().errors).toContainEqual(expect.objectContaining({ unitId: a.id, kind: 'main', message: 'concurrent failure' }));
    expect(app.snapshot().errors).toContainEqual(expect.objectContaining({ unitId: b.id, kind: 'main', message: 'concurrent failure' }));
  });

  it('clears only the matching request scope on a new submit or reset', async () => {
    const { app, backend } = await setup();
    const unit = await app.startStudy(context());
    backend.throwMessage = 'main failed';
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'main' });
    backend.throwMessage = 'quick failed';
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: 'quick', conversationId: 'side' });
    expect(app.snapshot().errors).toHaveLength(2);
    await app.resetMainSession(unit.id);
    expect(app.snapshot().errors).toContainEqual(expect.objectContaining({ kind: 'quick', conversationId: 'side' }));
    expect(app.snapshot().errors).not.toContainEqual(expect.objectContaining({ kind: 'main', conversationId: `main:${unit.id}` }));
    backend.throwMessage = undefined;
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: 'retry', conversationId: 'side' });
    expect(app.snapshot().errors).toHaveLength(0);
  });

  it('retains both failures when main and quick requests run concurrently', async () => {
    const { app, backend } = await setup(); const unit = await app.startStudy(context());
    let release!: () => void;
    backend.held = new Promise<void>(resolve => { release = resolve; });
    backend.throwMessage = 'network failed';
    const main = app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'main' });
    const quick = app.submit({ unitId: unit.id, context: context(), kind: 'quick', question: 'quick', conversationId: 'side' });
    expect(app.snapshot().running).toHaveLength(2);
    release();
    await Promise.all([main, quick]);
    expect(app.snapshot().errors.map(error => error.conversationId).sort()).toEqual([`main:${unit.id}`, 'side']);
    expect(new Set(app.snapshot().errors.map(error => error.requestId)).size).toBe(2);
  });

  it('automatically binds an empty new file, restores existing conversations and honors a pinned source', async () => {
    const { app } = await setup(); const a = await app.startStudy(context()); const b = await app.startStudy(context('B.md'));
    await app.focusSource('unknown.md');
    expect(app.snapshot().units.find(unit => unit.id === app.snapshot().activeUnitId)?.sourcePath).toBe('unknown.md');
    expect(app.snapshot().units).toHaveLength(3);
    app.focusSource('B.md'); expect(app.snapshot().activeUnitId).toBe(b.id);
    app.focusSource('A.md'); expect(app.snapshot().activeUnitId).toBe(a.id);
    app.setPinned(true); app.focusSource('B.md'); expect(app.snapshot().activeUnitId).toBe(a.id);
  });

  it('validates context before making any backend request', async () => {
    const { app, backend } = await setup(); const unit = await app.startStudy(context());
    await expect(app.submit({ unitId: unit.id, context: context('wrong.md'), kind: 'main', question: '问题' })).rejects.toThrow('不一致');
    await expect(app.submit({ unitId: unit.id, context: context(), kind: 'quick', conversationId: `main:${unit.id}`, question: '问题' })).rejects.toThrow('标识');
    expect(backend.requests).toHaveLength(0);
  });

  it('captures the default only when a unit is created and rejects provider changes on submit', async () => {
    const backend = new Backend(); const repository = new MemoryRepository();
    let selected: 'claude' | 'codex' = 'claude';
    let id = 0;
    const app = new StudyController(backend, repository, () => `provider-${++id}`, undefined, () => selected);
    await app.initialize();
    const first = await app.startStudy(context());
    selected = 'codex';
    const existing = await app.startStudy(context(), 'codex');
    expect(existing).toMatchObject({ id: first.id, provider: 'claude' });
    await app.submit({ unitId: first.id, context: context(), kind: 'main', question: 'stay' });
    expect(backend.requests[0]?.provider).toBe('claude');
    await expect(app.submit({ unitId: first.id, context: context(), kind: 'main', provider: 'codex', question: 'switch' })).rejects.toThrow('新开主线');
    const second = await app.startStudy(context('B.md'));
    expect(second.provider).toBe('codex');
  });

  it('lets an explicit main reset choose a new backend while retaining history', async () => {
    const { app, backend, repository } = await setup();
    const unit = await app.startStudy(context(), 'claude');
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'old' });
    await app.resetMainSession(unit.id, 'codex');
    expect(repository.state.units[0]?.provider).toBe('codex');
    expect(repository.state.units[0]?.mainSessionId).toBeUndefined();
    expect(repository.records).toHaveLength(1);
    await app.submit({ unitId: unit.id, context: context(), kind: 'main', question: 'new' });
    expect(backend.requests[1]).toMatchObject({ provider: 'codex', sessionId: undefined });
    expect(repository.records.map(record => record.provider)).toEqual(['claude', 'codex']);
  });

  it('remembers a Quick Ask provider before a session exists and across a failed answer', async () => {
    const repository = new MemoryRepository();
    const requests: BackendRequest[] = [];
    const backend: StudyBackend = {
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) throw new Error('failed before session');
        yield { type: 'text', text: 'recovered' };
        yield { type: 'done' };
      },
      dispose() {},
    };
    let selected: 'claude' | 'codex' = 'claude';
    const app = new StudyController(backend, repository, () => `quick-${requests.length + 1}`, undefined, () => selected);
    await app.initialize();
    const unit = await app.startStudy(context());
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', conversationId: 'side', provider: 'codex', question: 'first' });
    expect(repository.records[0]).toMatchObject({ provider: 'codex', state: 'error' });
    expect(repository.records[0]?.sessionId).toBeUndefined();
    selected = 'claude';
    await expect(app.submit({ unitId: unit.id, context: context(), kind: 'quick', conversationId: 'side', provider: 'claude', question: 'wrong' })).rejects.toThrow('新开旁路');
    await app.submit({ unitId: unit.id, context: context(), kind: 'quick', conversationId: 'side', question: 'retry' });
    expect(requests.map(request => request.provider)).toEqual(['codex', 'codex']);
    expect(repository.records.map(record => record.provider)).toEqual(['codex', 'codex']);
  });

  it('loads an ambiguous legacy main without failing and binds it only after an explicit migration choice', async () => {
    const backend = new Backend(); const repository = new MemoryRepository();
    const dual = 'study-backends-v1:{"claude":"legacy-c","codex":"legacy-x"}';
    repository.state.units.push({ id: 'legacy', sourcePath: 'A.md', createdAt: 'now', mainSessionId: dual });
    const app = new StudyController(backend, repository);
    await expect(app.initialize()).resolves.toBeUndefined();
    await expect(app.submit({ unitId: 'legacy', context: context(), kind: 'main', question: 'ambiguous' })).rejects.toThrow('同时包含 Claude 和 Codex');
    expect(backend.requests).toEqual([]);
    await app.bindMainProvider('legacy', 'codex');
    expect(repository.state.units[0]).toMatchObject({ provider: 'codex', mainSessionId: dual });
    await app.submit({ unitId: 'legacy', context: context(), kind: 'main', question: 'continue' });
    expect(backend.requests[0]).toMatchObject({ provider: 'codex', sessionId: undefined, retainSession: true });
  });

  it('lets an explicit provider migrate a legacy dual-session Quick Ask once', async () => {
    const backend = new Backend(); const repository = new MemoryRepository();
    const dual = 'study-backends-v1:{"claude":"legacy-c","codex":"legacy-x"}';
    repository.state.units.push({ id: 'legacy', sourcePath: 'A.md', createdAt: 'now', provider: 'claude' });
    repository.records.push({
      id: 'old-side', unitId: 'legacy', conversationId: 'side', kind: 'quick', context: context(),
      question: 'old', answer: 'old', createdAt: 'now', status: 'unresolved', state: 'complete', sessionId: dual,
    });
    const app = new StudyController(backend, repository);
    await app.initialize();
    await app.submit({ unitId: 'legacy', context: context(), kind: 'quick', conversationId: 'side', provider: 'codex', question: 'continue' });
    expect(backend.requests[0]).toMatchObject({ provider: 'codex', sessionId: undefined, retainSession: true });
    expect(repository.records[1]?.provider).toBe('codex');
    await expect(app.submit({ unitId: 'legacy', context: context(), kind: 'quick', conversationId: 'side', provider: 'claude', question: 'wrong' })).rejects.toThrow('新开旁路');
  });

  it('does not call the backend when a first-time legacy provider binding cannot be saved', async () => {
    const backend = new Backend(); const repository = new MemoryRepository();
    repository.state.units.push({ id: 'legacy', sourcePath: 'A.md', createdAt: 'now' });
    const app = new StudyController(backend, repository);
    await app.initialize();
    repository.failSave = true;
    await expect(app.submit({ unitId: 'legacy', context: context(), kind: 'main', provider: 'codex', question: 'question' })).rejects.toThrow('state save failed');
    expect(backend.requests).toEqual([]);
    expect(app.snapshot().units[0]?.provider).toBeUndefined();
  });
});

it('does not transfer another conversation context capacity into a usage-only completion', async () => {
  const repository = new MemoryRepository();
  let calls = 0;
  const backend: StudyBackend = {
    async *run() {
      calls++;
      if (calls === 1) yield { type: 'runtime', runtime: { contextTokens: 50, contextWindow: 100 } };
      yield { type: 'text', text: 'answer' };
      yield { type: 'done', usage: { inputTokens: 10 } };
    },
    dispose() {},
  };
  let id = 0;
  const app = new StudyController(backend, repository, () => String(++id));
  await app.initialize();
  const first = await app.startStudy(context('A.md'));
  await app.submit({ unitId: first.id, kind: 'main', context: context('A.md'), question: 'a' });
  expect(app.snapshot().runtimes?.find(item => item.unitId === first.id)?.contextWindow).toBe(100);
  const second = await app.startStudy(context('B.md'));
  await app.submit({ unitId: second.id, kind: 'main', context: context('B.md'), question: 'b' });
  expect(app.snapshot().runtimes?.map(item => item.unitId)).toEqual([first.id, second.id]);
  expect(app.snapshot().runtimes?.find(item => item.unitId === second.id)?.contextWindow).toBeUndefined();
  expect(app.snapshot().runtimes?.find(item => item.unitId === second.id)?.contextTokens).toBeUndefined();
  expect(app.snapshot().runtimes?.find(item => item.unitId === first.id)).toMatchObject({ contextTokens: 50, contextWindow: 100 });
});

it('merges interleaved reports only into their original conversation and resets only the selected main', async () => {
  const releases: (() => void)[] = [];
  const backend: StudyBackend = {
    async *run() {
      const order = releases.length + 1;
      const pending = new Promise<void>(resolve => releases.push(resolve));
      yield { type: 'runtime', runtime: { contextTokens: order * 10, contextWindow: order * 100 } };
      await pending;
      yield { type: 'text', text: 'answer' };
      yield { type: 'done', usage: { inputTokens: order } };
    }, dispose() {},
  };
  let id = 0;
  const app = new StudyController(backend, new MemoryRepository(), () => `parallel-${++id}`);
  await app.initialize();
  const first = await app.startStudy(context('A.md'));
  const a = app.submit({ unitId: first.id, kind: 'main', context: context('A.md'), question: 'a' });
  await vi.waitFor(() => expect(app.snapshot().runtimes).toHaveLength(1));
  const second = await app.startStudy(context('B.md'));
  const b = app.submit({ unitId: second.id, kind: 'main', context: context('B.md'), question: 'b' });
  await vi.waitFor(() => expect(app.snapshot().runtimes).toHaveLength(2));
  releases[0]!(); await a;
  releases[1]!(); await b;
  expect(app.snapshot().runtimes).toEqual([
    expect.objectContaining({ unitId: first.id, contextTokens: 10, contextWindow: 100, inputTokens: 1 }),
    expect.objectContaining({ unitId: second.id, contextTokens: 20, contextWindow: 200, inputTokens: 2 }),
  ]);
  await app.resetMainSession(first.id, 'codex');
  expect(app.snapshot().runtimes).toEqual([expect.objectContaining({ unitId: second.id, contextTokens: 20 })]);
  await app.dispose();
});

it('isolates multiple Quick Ask reports and invalidates only a deleted or restored conversation', async () => {
  let calls = 0; let id = 0;
  const repository = new MemoryRepository();
  const app = new StudyController({ async *run() {
    yield { type: 'text', text: 'answer' };
    yield { type: 'done', usage: { contextTokens: ++calls * 10, contextWindow: 100 } };
  }, dispose() {} }, repository, () => `scoped-${++id}`);
  await app.initialize();
  const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: 'main' });
  for (const conversationId of ['quick:first', 'quick:second']) {
    await app.submit({ unitId: unit.id, kind: 'quick', conversationId, context: context(), question: 'quick' });
  }
  expect(app.snapshot().runtimes?.map(item => item.contextTokens)).toEqual([10, 20, 30]);
  const clone = app.snapshot(); clone.runtimes![0]!.contextTokens = 999;
  expect(app.snapshot().runtimes![0]!.contextTokens).toBe(10);
  await app.deleteConversation(repository.records[1]!.id);
  expect(app.snapshot().runtimes?.map(item => item.contextTokens)).toEqual([10, 30]);
  await app.restoreConversation(repository.state.deletedConversations![0]!.id);
  expect(app.snapshot().runtimes?.map(item => item.contextTokens)).toEqual([10, 30]);
  await app.resetMainSession(unit.id);
  expect(app.snapshot().runtimes).toEqual([expect.objectContaining({ conversationId: 'quick:second', contextTokens: 30 })]);
  await app.dispose();
});

it('freezes tool settings, keeps preparatory sessions isolated, and persists the actual read with the answer', async () => {
  const repository = new MemoryRepository();
  const requests: BackendRequest[] = [];
  const settings = { scope: 'folder' as const, web: false };
  let enabled = true; let planned = false;
  const backend: StudyBackend = {
    async *run(request) {
      requests.push(request);
      yield { type: 'session', sessionId: request.requestId.includes(':tools:') ? 'preparation-only' : 'final-main-session' };
      if (request.requestId.includes(':tools:')) {
        yield { type: 'text', text: JSON.stringify(planned ? { tool: 'answer' } : { tool: 'Read', path: 'related.md', startLine: 1 }) };
        planned = true; enabled = false;
      } else yield { type: 'text', text: '关联内容见 [[related.md]]。' };
      yield { type: 'done' };
    },
    dispose() {},
  };
  const agent = new LearningTools({
    list: () => [{ path: 'related.md', size: 30, mtime: 1 }],
    read: async () => '# 关联知识\n这是当前读取的原文。',
  });
  let id = 0;
  const app = new StudyController(backend, repository, () => String(++id), undefined, undefined, undefined, undefined,
    { agent, settings: () => ({ ...settings, scope: enabled ? 'folder' : 'off' }) });
  await app.initialize();
  const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: '查找关联笔记' });
  const saved = repository.records[0]!;
  expect(saved.state).toBe('complete');
  expect(saved.toolTrace?.[0]).toMatchObject({ tool: 'Read', path: 'related.md' });
  expect(requests.at(-1)?.prompt).toContain('这是当前读取的原文');
  expect(saved.requestMetrics).toMatchObject({ modelCalls: 3, phases: { preparation: 0, retrieval: 2, web: 0, answer: 1 } });
  expect(saved.sessionId).toBe('final-main-session');
  expect(repository.state.units[0]?.mainSessionId).toBe('final-main-session');
  expect(requests.filter(r => r.requestId.includes(':tools:')).every(r => r.sessionId === undefined)).toBe(true);
});


it('deduplicates concurrent automatic file bindings without reading or calling the model', async () => {
  const { app, backend, repository } = await setup();
  await Promise.all([app.focusSource('New.md'), app.focusSource('New.md'), app.focusSource('New.md')]);
  expect(repository.state.units).toHaveLength(1);
  expect(app.snapshot().activeUnitId).toBe(repository.state.units[0]!.id);
  expect(repository.state.units[0]).toMatchObject({ sourcePath: 'New.md', provider: 'claude' });
  expect(backend.requests).toEqual([]); expect(repository.records).toEqual([]);
});

it('keeps the latest file active when automatic creation finishes out of date', async () => {
  const { app, backend, repository } = await setup();
  let release!: () => void;
  repository.saveGate = new Promise<void>(resolve => { release = resolve; });
  const first = app.focusSource('A.md');
  const second = app.focusSource('B.pdf');
  release(); await Promise.all([first, second]);
  expect(app.snapshot().units.find(unit => unit.id === app.snapshot().activeUnitId)?.sourcePath).toBe('B.pdf');
  expect(repository.state.units).toHaveLength(2); expect(backend.requests).toEqual([]);
});

it('does not create source conversations in normal mode, for generated records or unsupported files', async () => {
  const { app, repository } = await setup();
  await app.focusSource('Study Companion/record.md');
  await app.focusSource('Study Companion Cache/page.md');
  await app.focusSource('photo.png');
  app.setMode('normal'); await app.focusSource('New.md');
  expect(repository.state.units).toEqual([]);
});

it('does not activate delayed automatic creation after locking or changing mode', async () => {
  const { app, repository } = await setup();
  let release!: () => void;
  repository.saveGate = new Promise<void>(resolve => { release = resolve; });
  const pending = app.focusSource('New.md');
  app.setMode('normal'); release(); await pending;
  expect(app.snapshot().mode).toBe('normal'); expect(app.snapshot().activeUnitId).toBeUndefined();
});

it('reports persistence failure and permits automatic binding to be retried', async () => {
  const { app, repository, backend } = await setup();
  repository.failSave = true;
  await expect(app.focusSource('New.md')).rejects.toThrow('state save failed');
  expect(app.snapshot().units).toEqual([]);
  repository.failSave = false; await app.focusSource('New.md');
  expect(app.snapshot().units).toHaveLength(1); expect(backend.requests).toEqual([]);
});


it('renames a newly created source even while its initial binding is still being persisted', async () => {
  const { app, repository } = await setup();
  let release!: () => void;
  repository.saveGate = new Promise<void>(resolve => { release = resolve; });
  const creating = app.focusSource('Untitled.md');
  const renaming = app.renameSource('Untitled.md', 'Lesson.md');
  const focusing = app.focusSource('Lesson.md');
  release(); await Promise.all([creating, renaming, focusing]);
  expect(repository.state.units).toHaveLength(1);
  expect(repository.state.units[0]!.sourcePath).toBe('Lesson.md');
  expect(app.snapshot().activeUnitId).toBe(repository.state.units[0]!.id);
});

it('answers the reported selected-term question with one call and no retrieval, even with legacy folder settings', async () => {
  const backend = new Backend(); const repository = new MemoryRepository();
  let reads = 0;
  const agent = new LearningTools({ list: () => [{ path: 'other.md', size: 1, mtime: 1 }], read: async () => { reads++; return 'unrelated'; } });
  const app = new StudyController(backend, repository, undefined, undefined, undefined, undefined, undefined,
    { agent, settings: () => ({ scope: 'folder', web: true }) });
  await app.initialize();
  const quote = { ...context(), selectedText: '测试金字塔', before: '底层单元测试多而快，中层集成测试，顶层端到端测试少而慢。' };
  const unit = await app.startStudy(quote);
  await app.submit({ unitId: unit.id, kind: 'main', context: quote, question: '讲解一下' });
  expect(backend.requests).toHaveLength(1);
  expect(reads).toBe(0);
  expect(backend.requests[0]?.prompt).toContain('测试金字塔');
  expect(repository.records[0]).toMatchObject({ state: 'complete', context: quote,
    requestMetrics: { modelCalls: 1, phases: { preparation: 0, retrieval: 0, web: 0, answer: 1 } } });
});

it.each(['same-main', 'other-main', 'quick', 'reset-main'] as const)('resolves a web followup only inside its current conversation: %s', async scope => {
  const repository = new MemoryRepository(); const requests: BackendRequest[] = [];
  let planned = false;
  const backend: StudyBackend = {
    async *run(request) {
      requests.push(request);
      if (request.webAccess) {
        yield { type: 'web-tool', name: 'WebSearch' };
        yield { type: 'text', text: 'Public source: https://example.com' };
      } else if (request.requestId.includes(':tools:')) {
        yield { type: 'text', text: JSON.stringify(planned ? { tool: 'answer' } : { tool: 'WebSearch', query: 'cache official documentation' }) };
        planned = true;
      } else yield { type: 'text', text: '回答' };
      yield { type: 'done' };
    }, dispose() {},
  };
  const app = new StudyController(backend, repository, undefined, undefined, undefined, undefined, undefined,
    { agent: new LearningTools({ list: () => [], read: async () => { throw new Error('No local reads expected'); } }), settings: () => ({ scope: 'source', web: true }) });
  await app.initialize();
  const unit = await app.startStudy(context());
  repository.records.push({ id: 'previous', unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`, createdAt: '2026-09-15',
    context: context(), question: '缓存的有效期怎样确定？', answer: '我可以联网查一下官方文档。', state: 'complete', status: 'unresolved' });
  await app.refreshRecords();
  const destination = scope === 'other-main' ? await app.startStudy(context('B.md')) : unit;
  if (scope === 'reset-main') await app.resetMainSession(unit.id, 'claude');
  const quickId = scope === 'quick' ? await app.startQuick(unit.id, 'claude') : undefined;
  await app.submit({ unitId: destination.id, kind: scope === 'quick' ? 'quick' : 'main', conversationId: quickId,
    context: context(destination.sourcePath), question: '好，查一下' });
  expect(requests.some(r => r.webAccess)).toBe(scope === 'same-main');
  if (scope === 'same-main') {
    expect(requests.find(r => r.requestId.includes(':tools:'))?.prompt).toContain('缓存的有效期怎样确定');
    expect(requests.filter(r => r.webAccess).every(r => !r.sessionId)).toBe(true);
    expect(repository.records.at(-1)?.toolTrace?.[0]?.tool).toBe('WebSearch');
  } else expect(requests).toHaveLength(1);
});

it.each(['你好', '2+2', '2+2等于几？', '：2+2？', '请计算 (12.5 - 2) / 3，只回复结果。', 'Reply with only the result: 3+3.'])('answers a self-contained turn without retrieval planning: %s', async question => {
  const backend = new Backend(); const repository = new MemoryRepository();
  let reads = 0;
  const agent = new LearningTools({ list: () => { reads++; return []; }, read: async () => { reads++; return ''; } });
  const app = new StudyController(backend, repository, undefined, undefined, undefined, undefined, undefined,
    { agent, settings: () => ({ scope: 'folder', web: true }) });
  await app.initialize();
  const source = { ...context(), selectedText: '', before: '', after: '' };
  const unit = await app.startStudy(source);
  await app.submit({ unitId: unit.id, kind: 'main', context: source, question });
  const calls = question === '你好' ? 1 : 0;
  expect(backend.requests).toHaveLength(calls); expect(reads).toBe(0);
  expect(repository.records[0]).toMatchObject({ state: 'complete', requestMetrics: { phases: { retrieval: 0, answer: calls } } });
  if (!calls) expect(repository.records[0]?.answer).toMatch(/^(4|6|3\.5)$/u);
});

it.each(['claude', 'codex'] as const)('includes local answers when continuing a %s conversation', async provider => {
  const backend = new Backend(); const repository = new MemoryRepository();
  const app = new StudyController(backend, repository, undefined, undefined, () => provider);
  await app.initialize(); const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: '2+2' });
  expect(backend.requests).toHaveLength(0);
  expect(repository.records[0]).toMatchObject({ answer: '4', model: '本地精确计算', contextManaged: true });
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: '为什么是这个结果？' });
  expect(backend.requests).toHaveLength(1);
  expect(backend.requests[0]?.prompt).toContain('2+2');
  expect(backend.requests[0]?.prompt).toContain('4');
  expect(backend.requests[0]?.sessionId).toBeUndefined();
});

it.each(['source', 'attachment', 'quick'] as const)('does not replace evidence-aware %s requests with a calculator', async mode => {
  const { app, backend, repository } = await setup(); const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: mode === 'quick' ? 'quick' : 'main', context: context(), question: '2+2',
    ...(mode === 'source' ? { answerPolicy: 'source' as const } : {}), ...(mode === 'attachment' ? { attachments: [context('B.md')] } : {}) });
  expect(backend.requests).toHaveLength(1);
  expect(repository.records[0]?.model).not.toBe('本地精确计算');
});

it('rejects a stale private history if it changes during the new direct source read', async () => {
  const backend = new Backend(); const repository = new MemoryRepository();
  const agent = new LearningTools({ list: () => [{ path: 'A.md', size: 20, mtime: 1 }], read: async () => {
    repository.records[0]!.answer = 'edited while reading'; return 'source definition';
  } });
  const app = new StudyController(backend, repository, undefined, undefined, () => 'codex', undefined, undefined,
    { agent, settings: () => ({ scope: 'source', web: false }) });
  await app.initialize(); const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: 'hello', answerPolicy: 'direct' });
  await app.submit({ unitId: unit.id, kind: 'main', context: { ...context(), selectedText: '' }, question: '读取原文解释', answerPolicy: 'source' });
  expect(backend.requests).toHaveLength(1);
  expect(repository.records.at(-1)).toMatchObject({ state: 'error', error: expect.stringContaining('记录在准备期间已改变') });
});

it('stores concise progressive followups while only the model receives the selected answer background', async () => {
  const { app, backend, repository } = await setup();
  const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: 'Why pivot?' });
  repository.records[0]!.answer = '**原理**：$n/5$，参考 [原文](A.md)。';
  await app.explainAgain(repository.records[0]!.id, true);
  const example = repository.records[1]!;
  expect(example).toMatchObject({ question: '举例说明', followup: { kind: 'example', recordId: repository.records[0]!.id }, kind: 'main', conversationId: `main:${unit.id}` });
  expect(backend.requests[1]!.prompt).toContain('**原理**');
  expect(example.question).not.toContain('原理');
  await app.explainAgain(example.id, false);
  expect(repository.records[2]).toMatchObject({ question: '继续深入', followup: { kind: 'deepen', recordId: example.id } });
  expect(repository.records[2]!.lesson).toBeUndefined();
  expect(backend.requests[2]!.prompt).toContain('补足理解所需的关键步骤与理由');
  expect(backend.requests[2]!.prompt).not.toContain('待解释的回答节选');
  const before = backend.requests.length;
  await app.resetMainSession(unit.id, 'claude');
  await expect(app.explainAgain(example.id, true)).rejects.toThrow('不属于当前对话');
  expect(backend.requests).toHaveLength(before);
});

it('direct bypasses all new retrieval while source-only retains local retrieval with web off', async () => {
  const backend = new Backend(); const repository = new MemoryRepository();
  const agent = new LearningTools({ list: () => [], read: async () => { throw new Error('unexpected read'); } });
  const prepare = vi.spyOn(agent, 'prepare').mockResolvedValue([]);
  const app = new StudyController(backend, repository, undefined, undefined, undefined, undefined, undefined,
    { agent, settings: () => ({ scope: 'source', web: true }) });
  await app.initialize(); const unit = await app.startStudy(context());
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), attachments: [context('B.md')],
    question: '读取当前笔记并搜索网页', answerPolicy: 'direct' });
  expect(prepare).not.toHaveBeenCalled();
  expect(backend.requests[0]?.prompt).not.toContain('学习片段');
  expect(repository.records[0]?.evidenceMode).toBe('conversation');
  await app.submit({ unitId: unit.id, kind: 'main', context: context(), question: '读取当前笔记并搜索网页', answerPolicy: 'source' });
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ settings: { scope: 'source', web: false } }));
  expect(backend.requests.at(-1)?.prompt).toContain('当前资料没有说明');
  expect(repository.records[1]?.conversationId).toBe(repository.records[0]?.conversationId);
});

it('persists context usage per conversation and restores it after controller reload', async () => {
  const repository = new MemoryRepository();
  const backend: StudyBackend = {
    async *run() { yield { type: 'done', usage: { contextTokens: 25, contextWindow: 100, model: 'test-model' } }; },
    dispose() {},
  };
  const first = new StudyController(backend, repository, () => 'unit-1');
  await first.initialize();
  const unit = await first.startStudy(context());
  await first.submit({ unitId: unit.id, kind: 'main', context: context(), question: '问题' });
  expect(repository.state.runtimes).toEqual([expect.objectContaining({ unitId: unit.id, kind: 'main', conversationId: 'main:' + unit.id, contextTokens: 25 })]);

  const reloaded = new StudyController(backend, repository);
  await reloaded.initialize();
  expect(reloaded.snapshot().runtimes).toEqual([expect.objectContaining({ unitId: unit.id, conversationId: 'main:' + unit.id, contextTokens: 25, contextWindow: 100 })]);
  await reloaded.resetMainSession(unit.id);
  expect(reloaded.snapshot().runtimes).toEqual([]);
});
