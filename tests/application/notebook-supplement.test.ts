import { describe, expect, it } from 'vitest';
import { parseLessonOutline } from '../../src/application/lesson';
import { NotebookSupplementGenerator } from '../../src/application/notebook-supplement';
import type { NotebookEntry } from '../../src/application/SourceNotebook';
import type {
  BackendEvent,
  BackendRequest,
  SourceContext,
  StudyBackend,
  StudyRecord,
  StudyRepository,
  StudyState,
  StudyUnit,
} from '../../src/core/contracts';

const markdownContext: SourceContext = {
  sourcePath: 'Notes/Physics.md', sourceName: 'Physics', selectedText: '速度定义', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 4 },
};
const unit: StudyUnit = { id: 'unit-a', sourcePath: markdownContext.sourcePath, createdAt: '2026-09-01' };

function record(id: string, overrides: Partial<StudyRecord> = {}): StudyRecord {
  return {
    id, unitId: unit.id, conversationId: `main:${unit.id}`, kind: 'main', context: markdownContext,
    question: `question-${id}`, answer: `answer-${id}`, createdAt: `2026-09-${id === 'r1' ? '01' : '02'}`,
    status: 'unresolved', state: 'complete', ...overrides,
  };
}

class Repository implements StudyRepository {
  records: StudyRecord[] = [record('r1'), record('r2')];
  async loadState(): Promise<StudyState> { return { version: 1, units: [unit] }; }
  async saveState() { throw new Error('must not write'); }
  async listRecords() { return structuredClone(this.records); }
  async createRecord() { throw new Error('must not write'); }
  async updateStatus() { throw new Error('must not write'); }
}

class Backend implements StudyBackend {
  requests: BackendRequest[] = [];
  response = JSON.stringify([{ recordId: 'r2', markdown: '核心公式：$v=s/t$' }]);
  fail?: string;
  omitDone = false;
  async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
    this.requests.push(request);
    yield { type: 'text', text: this.response };
    if (this.fail) yield { type: 'error', message: this.fail };
    if (!this.omitDone) yield { type: 'done' };
  }
  dispose() {}
}

describe('NotebookSupplementGenerator', () => {
  it('does not regenerate deleted conversations into notes or send them to a model', async () => {
    const repository = new Repository(); const backend = new Backend();
    repository.loadState = async () => ({ version: 1, units: [unit], deletedConversations: [{ id: 'd', unitId: unit.id,
      kind: 'main', conversationId: `main:${unit.id}`, deletedAt: '2026-09-18T00:00:00Z', recordIds: ['r1', 'r2'] }] });
    expect(await new NotebookSupplementGenerator(repository, backend).generate(unit, [], new AbortController().signal)).toEqual({ entries: [], recordCount: 0 });
    expect(backend.requests).toHaveLength(0);
  });
  it('uses latest durable main records, excludes saved IDs and isolates other record scopes', async () => {
    const repository = new Repository();
    repository.records.push(
      record('quick', { kind: 'quick', conversationId: 'side', question: 'QUICK_SECRET' }),
      record('other', { unitId: 'other', conversationId: 'main:other', question: 'OTHER_SECRET' }),
      record('failed', { state: 'error', question: 'FAILED_SECRET' }),
      record('unsaved', { unsaved: true, question: 'UNSAVED_SECRET' }),
      record('wrong-conversation', { conversationId: 'main:stale', question: 'STALE_SECRET' }),
    );
    const existing: NotebookEntry[] = [{ recordId: 'r1', kind: 'raw', markdown: '已保存的完整问答' }];
    const backend = new Backend();
    const result = await new NotebookSupplementGenerator(repository, backend)
      .generate({ ...unit, provider: 'codex' }, existing, new AbortController().signal);

    expect(result).toEqual({ entries: [{ recordId: 'r2', kind: 'summary', markdown: '核心公式：$v=s/t$' }], recordCount: 1 });
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).not.toHaveProperty('sessionId');
    expect(backend.requests[0]!.provider).toBe('codex');
    expect(backend.requests[0]!.prompt).toContain('question-r2');
    expect(backend.requests[0]!.prompt).toContain('已保存的完整问答');
    expect(backend.requests[0]!.prompt).toContain('不得改写、替换或返回这些既有条目');
    for (const excluded of ['question-r1', 'QUICK_SECRET', 'OTHER_SECRET', 'FAILED_SECRET', 'UNSAVED_SECRET', 'STALE_SECRET']) {
      expect(backend.requests[0]!.prompt).not.toContain(excluded);
    }

    repository.records.push(record('r3', { question: 'latest-on-disk', answer: 'new answer', createdAt: '2026-09-03' }));
    backend.response = JSON.stringify([
      { recordId: 'r2', markdown: 'r2 summary' },
      { recordId: 'r3', markdown: 'r3 summary' },
    ]);
    const refreshed = await new NotebookSupplementGenerator(repository, backend)
      .generate(unit, existing, new AbortController().signal);
    expect(refreshed.recordCount).toBe(2);
    expect(backend.requests[1]!.prompt).toContain('latest-on-disk');
  });

  it('returns empty without a model request when every current record is already saved', async () => {
    const repository = new Repository(); const backend = new Backend();
    const existing: NotebookEntry[] = repository.records.map(item => ({ recordId: item.id, kind: 'summary', markdown: item.answer }));
    await expect(new NotebookSupplementGenerator(repository, backend).generate(unit, existing, new AbortController().signal))
      .resolves.toEqual({ entries: [], recordCount: 0 });
    expect(backend.requests).toHaveLength(0);
  });

  it('reuses the active PDF lesson scope and rejects a deleted active plan', async () => {
    const pdf: SourceContext = {
      ...markdownContext, sourcePath: 'Courses/Physics.pdf', sourceName: 'Physics PDF', selectedText: '第1页速度。第2页加速度。',
      pdf: { pageCount: 3, pages: [1, 2], emptyPages: [] },
    };
    const outline = '## 1. 速度\n页码：1\n目标：理解速度。\n\n## 2. 加速度\n页码：2\n目标：理解加速度。';
    const topic = parseLessonOutline(outline, pdf)[0]!;
    const lessonUnit: StudyUnit = {
      ...unit, sourcePath: pdf.sourcePath,
      lesson: { planId: 'plan', order: parseLessonOutline(outline, pdf).map(item => item.key), skipped: [] },
    };
    const repository = new Repository();
    repository.records = [
      record('old', { context: pdf, question: 'BEFORE_PLAN_SECRET', createdAt: '2026-09-01' }),
      record('plan', { context: pdf, question: '目录', answer: outline, lesson: { kind: 'plan' }, createdAt: '2026-09-02' }),
      record('teach', { context: pdf, question: '讲解速度', answer: '速度讲解', lesson: { kind: 'teach', planId: 'plan', topicKey: topic.key }, createdAt: '2026-09-03' }),
      record('followup', { context: pdf, question: '课程追问', answer: '课程回答', createdAt: '2026-09-04' }),
    ];
    const backend = new Backend();
    backend.response = JSON.stringify([
      { recordId: 'plan', markdown: '目录摘要' },
      { recordId: 'teach', markdown: '速度摘要' },
      { recordId: 'followup', markdown: '追问摘要' },
    ]);
    const result = await new NotebookSupplementGenerator(repository, backend)
      .generate(lessonUnit, [], new AbortController().signal);
    expect(result.recordCount).toBe(3);
    expect(backend.requests[0]!.prompt).not.toContain('BEFORE_PLAN_SECRET');
    const payload = JSON.parse(backend.requests[0]!.prompt.split('\n\n').at(-1)!) as { courseCoverage: { state: string }[] };
    expect(payload.courseCoverage[0]?.state).toBe('已讲');

    repository.records = repository.records.filter(item => item.id !== 'plan');
    await expect(new NotebookSupplementGenerator(repository, backend).generate(lessonUnit, [], new AbortController().signal))
      .rejects.toThrow('删除');
    expect(backend.requests).toHaveLength(1);
  });

  it.each([
    ['extra ID', [{ recordId: 'r2', markdown: 'ok' }, { recordId: 'extra', markdown: 'bad' }], '不属于'],
    ['missing ID', [], '缺少'],
    ['duplicate ID', [{ recordId: 'r2', markdown: 'a' }, { recordId: 'r2', markdown: 'b' }], '重复'],
    ['empty markdown', [{ recordId: 'r2', markdown: '  ' }], '为空'],
    ['extra field', [{ recordId: 'r2', markdown: 'ok', extra: true }], '只能包含'],
  ] as const)('rejects %s in strict JSON output', async (_label, response, message) => {
    const repository = new Repository(); const backend = new Backend();
    backend.response = JSON.stringify(response);
    await expect(new NotebookSupplementGenerator(repository, backend).generate(
      unit, [{ recordId: 'r1', kind: 'raw', markdown: 'saved' }], new AbortController().signal,
    )).rejects.toThrow(message);
  });

  it('honors cancellation and backend or truncated-stream failures', async () => {
    const repository = new Repository();
    const controller = new AbortController();
    const waiting: StudyBackend = {
      async *run(request) {
        await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'done' };
      },
      dispose() {},
    };
    const pending = new NotebookSupplementGenerator(repository, waiting).generate(unit, [], controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const failed = new Backend(); failed.fail = 'backend failed';
    await expect(new NotebookSupplementGenerator(repository, failed).generate(unit, [], new AbortController().signal))
      .rejects.toThrow('backend failed');
    const truncated = new Backend(); truncated.omitDone = true;
    await expect(new NotebookSupplementGenerator(repository, truncated).generate(unit, [], new AbortController().signal))
      .rejects.toThrow('提前结束');
  });

  it('bounds existing notebook context instead of rejecting a 100000-character notebook', async () => {
    const repository = new Repository(); const backend = new Backend();
    const hugeExisting: NotebookEntry[] = [{ recordId: 'saved', kind: 'raw', markdown: 'x'.repeat(100_000) }];
    backend.response = JSON.stringify([{ recordId: 'r1', markdown: 'summary one' }, { recordId: 'r2', markdown: 'summary two' }]);
    const result = await new NotebookSupplementGenerator(repository, backend).generate(unit, hugeExisting, new AbortController().signal);
    expect(result.recordCount).toBe(2);
    expect(backend.requests[0]!.prompt.length).toBeLessThan(40_000);

    backend.response = 'x'.repeat(100_001);
    await expect(new NotebookSupplementGenerator(repository, backend).generate(unit, [], new AbortController().signal))
      .rejects.toThrow('输出预算');
  });
});
