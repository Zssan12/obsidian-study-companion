import { expect, it } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import { LearningTools } from '../../src/application/LearningTools';
import type { BackendEvent, BackendRequest, SourceContext, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';

async function fixture(kind: 'main' | 'quick' = 'main') {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [], requests: BackendRequest[] = [];
  const alive = new Set<string>();
  let serial = 0, threads = 0;
  let prepare: ((request: BackendRequest) => void | Promise<void>) | undefined;
  let nextRead: (() => void) | undefined;
  const repository: StudyRepository = {
    async loadState() { return structuredClone(state); },
    async saveState(next) { state = structuredClone(next); },
    async listRecords() { const hook = nextRead; nextRead = undefined; hook?.(); return structuredClone(records); },
    async createRecord(record) { records.push(structuredClone(record)); },
    async updateStatus() {},
  };
  const backend = {
    hasSession: (id: string) => alive.has(id),
    async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
      requests.push(request);
      if (!request.retainSession) {
        await prepare?.(request);
        yield { type: 'text', text: request.requestId.includes(':tools:') ? '{"tool":"answer"}' : 'SUMMARY_OF_OLD_HISTORY' };
        yield { type: 'done' };
        return;
      }
      const sessionId = request.sessionId ?? `thread-${++threads}`;
      alive.add(sessionId);
      yield { type: 'session', sessionId };
      yield { type: 'text', text: 'ORIGINAL_ANSWER' };
      yield { type: 'done' };
    },
    dispose() { alive.clear(); },
  };
  const app = new StudyController(backend, repository, () => `id-${++serial}`,
    () => new Date(1_800_000_000_000 + serial * 1000).toISOString(), () => 'codex', undefined, undefined,
    { agent: new LearningTools({ list: () => [{ path: 'Synthetic.md', size: 4000, mtime: 1 }], async read() { return 'x'.repeat(4000); } }), settings: () => ({ scope: 'source', web: false }) });
  const context: SourceContext = { sourcePath: 'Synthetic.md', sourceName: 'Synthetic', selectedText: 'Synthetic source.',
    before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
  await app.initialize();
  const unit = await app.startStudy(context);
  const conversationId = kind === 'quick' ? await app.startQuick(unit.id, 'codex') : undefined;
  const send = (question = 'Read the source notes and explain the definition.', answerPolicy: 'source' | 'direct' = 'source') =>
    app.submit({ unitId: unit.id, kind, conversationId, context, question, answerPolicy });
  await send('Remember the original question.', 'direct');
  return { app, records, requests, alive, send,
    answers: () => requests.filter(request => request.retainSession),
    onPrepare: (hook?: typeof prepare) => { prepare = hook; },
    onNextRead: (hook: () => void) => { nextRead = hook; } };
}

it.each([
  ['main', 'retained', 'edit'], ['main', 'retained', 'remove'],
  ['main', 'rebuilt', 'edit'], ['main', 'rebuilt', 'remove'],
  ['quick', 'retained', 'edit'], ['quick', 'retained', 'remove'],
  ['quick', 'rebuilt', 'edit'], ['quick', 'rebuilt', 'remove'],
] as const)('rejects %s %s history after a %s during retrieval, then rebuilds on explicit resend', async (kind, continuity, change) => {
  const f = await fixture(kind);
  try {
    if (continuity === 'rebuilt') f.alive.clear();
    f.onPrepare(() => {
      if (change === 'edit') f.records[0]!.answer = 'EDITED_ANSWER';
      else f.records.splice(0, 1);
      // No background refresh: the final dispatch boundary must read Markdown itself.
    });
    await f.send();
    expect(f.requests.filter(request => !request.retainSession)).toHaveLength(1);
    expect(f.answers()).toHaveLength(1);
    expect(f.records.at(-1)).toMatchObject({ state: 'error', answer: '', error: expect.stringContaining('记录在准备期间已改变') });
    expect(f.app.snapshot().running).toHaveLength(0);

    f.onPrepare();
    await f.send('Explain the previous answer.', 'direct');
    expect(f.answers()).toHaveLength(2);
    const retried = f.answers().at(-1)!;
    expect(retried.sessionId).toBeUndefined();
    expect(retried.prompt).not.toContain('ORIGINAL_ANSWER');
    if (change === 'edit') expect(retried.prompt).toContain('EDITED_ANSWER');
    else expect(retried.prompt).not.toContain('Remember the original question.');
    expect(f.records.at(-1)!.state).toBe('complete');
  } finally { await f.app.dispose(); }
});

it('rejects a stale history summary before starting an answer', async () => {
  const f = await fixture();
  try {
    f.records[0]!.answer = '旧历史'.repeat(20_000);
    f.onPrepare(request => {
      expect(request.prompt).toContain('更新学习状态摘要');
      f.records[0]!.answer = 'EDITED_WHILE_SUMMARIZING';
    });
    await f.send('Explain the previous answer.', 'direct');
    expect(f.requests.some(request => !request.retainSession)).toBe(true);
    expect(f.answers()).toHaveLength(1);
    expect(f.records.at(-1)).toMatchObject({ state: 'error', answer: '', error: expect.stringContaining('记录在准备期间已改变') });
  } finally { await f.app.dispose(); }
});

it.each(['read failure', 'cancel'] as const)('does not dispatch an answer after %s at the final history refresh', async outcome => {
  const f = await fixture();
  try {
    f.onPrepare(() => f.onNextRead(() => {
      if (outcome === 'read failure') throw new Error('Final Markdown read failed');
      f.app.cancel(f.app.snapshot().running[0]!.requestId);
    }));
    await f.send();
    expect(f.answers()).toHaveLength(1);
    expect(f.records.at(-1)).toMatchObject({ state: outcome === 'cancel' ? 'cancelled' : 'error', answer: '' });
    if (outcome === 'read failure') expect(f.records.at(-1)!.error).toBe('Final Markdown read failed');
  } finally { await f.app.dispose(); }
});

it.each(['favorite', 'other conversation'] as const)('keeps valid continuity when only %s changes during preparation', async change => {
  const f = await fixture();
  try {
    f.onPrepare(() => {
      if (change === 'favorite') f.records[0]!.favorite = true;
      else f.records.push({ ...structuredClone(f.records[0]!), id: 'other-record', unitId: 'other-unit', conversationId: 'main:other-unit', answer: 'UNRELATED_ANSWER' });
    });
    await f.send();
    expect(f.answers()).toHaveLength(2);
    expect(f.answers()[1]!.sessionId).toBe('thread-1');
    expect(f.answers()[1]!.prompt).not.toContain('ORIGINAL_ANSWER');
    expect(f.answers()[1]!.prompt).not.toContain('UNRELATED_ANSWER');
    expect(f.records.at(-1)!.state).toBe('complete');
  } finally { await f.app.dispose(); }
});

it('accepts an edit read before choosing the history snapshot without comparing against stale UI records', async () => {
  const f = await fixture();
  try {
    f.records[0]!.answer = 'EDITED_BEFORE_PREPARATION';
    await f.send();
    expect(f.answers()).toHaveLength(2);
    expect(f.answers()[1]!.sessionId).toBeUndefined();
    expect(f.answers()[1]!.prompt).toContain('EDITED_BEFORE_PREPARATION');
    expect(f.records.at(-1)!.state).toBe('complete');
  } finally { await f.app.dispose(); }
});
