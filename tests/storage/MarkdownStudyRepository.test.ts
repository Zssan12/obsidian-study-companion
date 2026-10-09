import { describe, expect, it } from 'vitest';
import type { FilePort, SourceContext, StatePort, StudyRecord, StudyState } from '../../src/core/contracts';
import {
  InvalidStateError,
  InvalidStoragePathError,
  MarkdownStudyRepository,
  RecordAlreadyExistsError,
  RecordNotFoundError,
} from '../../src/adapters/storage/MarkdownStudyRepository';

class MemoryFilePort implements FilePort {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing file: ${path}`);
    return value;
  }

  async create(path: string, text: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`Already exists: ${path}`);
    this.files.set(path, text);
  }

  async process(path: string, transform: (current: string) => string): Promise<void> {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`Missing file: ${path}`);
    this.files.set(path, transform(current));
  }

  async mkdir(path: string): Promise<void> {
    this.folders.add(path);
  }

  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = `${folder}/`;
    return [...this.files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/') && path.endsWith('.md'));
  }
}

class MemoryStatePort implements StatePort {
  value: unknown;

  constructor(value: unknown = undefined) {
    this.value = value;
  }

  async load(): Promise<unknown> {
    return this.value;
  }

  async save(state: StudyState): Promise<void> {
    this.value = structuredClone(state);
  }
}

function context(): SourceContext {
  return {
    sourcePath: 'notes/原理.md',
    sourceName: '原理.md',
    selectedText: 'selected',
    before: 'before',
    after: 'after',
    from: { line: 3, ch: 2 },
    to: { line: 4, ch: 8 },
  };
}

function record(overrides: Partial<StudyRecord> = {}): StudyRecord {
  return {
    id: 'record-1',
    unitId: 'unit-1',
    conversationId: 'main:unit-1',
    kind: 'main',
    context: context(),
    question: 'Why does this work?',
    answer: 'Because it does.',
    createdAt: '2026-09-10T10:00:00.000Z',
    status: 'unresolved',
    state: 'complete',
    ...overrides,
  };
}

describe('MarkdownStudyRepository', () => {
  it('round trips image references without storing image bytes', async () => {
    const files = new MemoryFilePort(); const state = new MemoryStatePort();
    const image = { ...context(), sourcePath: 'Study Companion Attachments/image.png', image: { sha256: 'a'.repeat(64) } };
    const saved = record({ context: image, attachments: [image] });
    await new MarkdownStudyRepository(files, state).createRecord(saved);
    expect(await new MarkdownStudyRepository(files, state).listRecords()).toEqual([saved]);
  });
  it('round trips deletion markers without copying or changing answer files', async () => {
    const files = new MemoryFilePort(); const state = new MemoryStatePort(); const repo = new MarkdownStudyRepository(files, state);
    const owner = { unitId: 'unit-1', kind: 'main' as const, conversationId: 'main:unit-1' };
    const saved: StudyState = { version: 1, units: [{ id: 'unit-1', sourcePath: 'A.md', createdAt: 'now' }],
      deletedConversations: [{ ...owner, id: 'delete-1', deletedAt: '2026-09-18T00:00:00Z', recordIds: ['record-1'] }], detachedConversations: [owner] };
    await repo.saveState(saved);
    expect(await new MarkdownStudyRepository(files, state).loadState()).toEqual(saved);
    expect(files.files.size).toBe(0);
    await expect(repo.saveState({ ...saved, deletedConversations: [{ ...saved.deletedConversations![0]!, recordIds: ['record-1', 'record-1'] }] })).rejects.toThrow('Duplicate');
    await expect(repo.saveState({ ...saved, detachedConversations: [{ ...owner, unitId: 'missing' }] })).rejects.toThrow('scope');
    expect(await repo.loadState()).toEqual(saved);
  });
  it('round trips answer policy and actual evidence routing without changing old records', async () => {
    const files = new MemoryFilePort(); const state = new MemoryStatePort();
    const saved = record({ answerPolicy: 'auto', evidenceMode: 'conversation' });
    await new MarkdownStudyRepository(files, state).createRecord(saved);
    expect(await new MarkdownStudyRepository(files, state).listRecords()).toEqual([saved]);
    const path = 'Study Companion/record-1.md';
    files.files.set(path, files.files.get(path)!.replace('answerPolicy: "auto"', 'answerPolicy: "invalid"'));
    expect(await new MarkdownStudyRepository(files, state).listRecords()).toEqual([]);
  });
  it('preserves model-answer provenance for a normal Quick Ask without inventing a file path', async () => {
    const files = new MemoryFilePort(); const state = new MemoryStatePort();
    const saved = record({ mode: 'normal', kind: 'quick', conversationId: 'quick:normal',
      context: { ...context(), sourcePath: '', answerRecordId: 'original-answer', sourcePages: [80] } });
    await new MarkdownStudyRepository(files, state).createRecord(saved);
    expect((await new MarkdownStudyRepository(files, state).listRecords())[0]?.context).toEqual(saved.context);
  });
  it('round trips a 300-page document reference, request evidence and history reset boundaries', async () => {
    const files = new MemoryFilePort(); const state = new MemoryStatePort(); const repository = new MarkdownStudyRepository(files, state);
    const pdf = { indexed: true as const, sha256: 'a'.repeat(64), pageCount: 300, pages: Array.from({ length: 300 }, (_, i) => i + 1), emptyPages: [300] };
    const saved = record({ context: { ...context(), pdf, selectedText: '本地页面缓存' }, historyEpoch: 'new', contextManaged: true,
      requestEvidence: { ...context(), pdf: { ...pdf, indexed: undefined, pages: [299], emptyPages: [] }, selectedText: '第299页实际证据' } });
    await repository.createRecord(saved);
    await repository.saveState({ version: 1, units: [{ id: 'unit-1', sourcePath: 'Book.pdf', createdAt: 'now', historyEpoch: 'new' }] });
    const reload = new MarkdownStudyRepository(files, state);
    expect(await reload.listRecords()).toEqual([saved]); expect((await reload.loadState()).units[0]?.historyEpoch).toBe('new');
  });
  it('persists favorites and tags without replacing user edits or recreating removed records', async () => {
    const files = new MemoryFilePort(); const state = new MemoryStatePort();
    const repository = new MarkdownStudyRepository(files, state);
    await repository.createRecord(record({ model: 'synthetic-model' }));
    expect((await repository.listRecords())[0]?.favorite).toBeUndefined();
    const path = 'Study Companion/record-1.md';
    const original = files.files.get(path)!.replace('Because it does.', 'User edited answer.');
    files.files.set(path, original);
    await repository.updateCollection('record-1', { favorite: true, tags: ['复习', '力学'] });
    const reloaded = new MarkdownStudyRepository(files, state);
    expect((await reloaded.listRecords())[0]).toMatchObject({ favorite: true, tags: ['复习', '力学'], answer: 'User edited answer.', model: 'synthetic-model' });
    await reloaded.updateCollection('record-1', { favorite: false });
    expect((await reloaded.listRecords())[0]).toMatchObject({ favorite: false, tags: ['复习', '力学'] });
    expect(files.files.get(path)!.split('# Question')[1]).toBe(original.split('# Question')[1]);
    await expect(reloaded.updateCollection('record-1', { tags: ['x'.repeat(81)] })).rejects.toThrow();
    files.files.delete(path);
    await expect(reloaded.updateCollection('record-1', { favorite: true })).rejects.toThrow(RecordNotFoundError);
    expect(files.files.has(path)).toBe(false);
  });

  it('round trips the active Quick Ask identity even before a first answer', async () => {
    const state = new MemoryStatePort(); const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, state);
    const value: StudyState = { version: 1, units: [{ id: 'a', sourcePath: 'A.md', createdAt: 'now', quickConversation: { id: 'quick:new', provider: 'codex' } }] };
    await repository.saveState(value);
    expect(await new MarkdownStudyRepository(files, state).loadState()).toEqual(value);
  });
  it('round trips evidence traces and isolates malformed evidence metadata', async () => {
    const files = new MemoryFilePort(); const repository = new MarkdownStudyRepository(files, new MemoryStatePort());
    const source = { ...context(), sourcePath: 'A.pdf', pdf: { sha256: 'a'.repeat(64), pageCount: 1, pages: [1], emptyPages: [] } };
    const saved = record({ context: source, evidenceTrace: { version: 1, sourcePath: 'A.pdf', sha256: 'a'.repeat(64), scope: [1],
      steps: [{ action: { action: 'answer', reason: 'enough' }, result: 'done', elapsedMs: 10 }], evidencePages: [1], imageLabels: [], stop: 'sufficient', modelCalls: 2, elapsedMs: 20, usage: { inputTokens: 10 } } });
    await repository.createRecord(saved);
    expect(await repository.listRecords()).toEqual([saved]);
    const insufficient = record({ id: 'insufficient', context: source, evidenceTrace: { ...saved.evidenceTrace!, stop: 'insufficient',
      steps: [{ action: { action: 'answer', evidenceStatus: 'insufficient', reason: 'missing table' }, result: 'insufficient', elapsedMs: 10 }] } });
    await repository.createRecord(insufficient);
    expect(await repository.listRecords()).toEqual(expect.arrayContaining([saved, insufficient]));
    const path = 'Study Companion/record-1.md';
    files.files.set(path, files.files.get(path)!.replace('"scope":[1]', '"scope":[2]'));
    expect(await repository.listRecords()).toEqual([insufficient]);
    expect(repository.getDiagnostics()).toHaveLength(1);
  });

  it('round trips lesson preferences and readable lesson records, including edits and malformed metadata isolation', async () => {
    const files = new MemoryFilePort(); const statePort = new MemoryStatePort();
    const repository = new MarkdownStudyRepository(files, statePort);
    const pdf = { ...context(), sourcePath: 'Course.pdf', pdf: { pageCount: 2, pages: [1, 2], emptyPages: [] } };
    const plan = record({ context: pdf, lesson: { kind: 'plan' }, answer: '## 1. 主题\n页码：1-2\n目标：理解概念。' });
    const taught = record({ id: 'teach', context: pdf, lesson: { kind: 'teach', planId: plan.id, topicKey: 'topic-one' } });
    const state: StudyState = { version: 1, units: [{ id: 'unit-1', sourcePath: 'Course.pdf', createdAt: 'now',
      lesson: { planId: plan.id, order: ['topic-one'], skipped: [] } }] };
    await repository.saveState(state); expect(await repository.loadState()).toEqual(state);
    await repository.createRecord(plan); await repository.createRecord(taught);
    expect(await repository.listRecords()).toEqual(expect.arrayContaining([plan, taught]));
    const path = `Study Companion/${plan.id}.md`;
    files.files.set(path, files.files.get(path)!.replace('理解概念。', '手动修改目标。'));
    expect((await repository.listRecords()).find(item => item.id === plan.id)!.answer).toContain('手动修改目标');
    const bad = files.files.get(path)!.replace(/^lesson:.*$/m, 'lesson: {"kind":"teach","planId":false}');
    files.files.set(path, bad);
    expect(await repository.listRecords()).toEqual([taught]);
    expect(files.files.get(path)).toBe(bad);
    expect(repository.getDiagnostics()).toHaveLength(1);
  });
  it('persists PDF page evidence in the main source and attachments', async () => {
    const repository = new MarkdownStudyRepository(new MemoryFilePort(), new MemoryStatePort());
    const pdf = { ...context(), sourcePath: 'Lesson.pdf', pdf: { pageCount: 10, pages: [2, 4], emptyPages: [4] } };
    const original = record({ context: pdf, attachments: [pdf] });
    await repository.createRecord(original);
    expect(await repository.listRecords()).toEqual([original]);
    await repository.updateStatus(original.id, 'understood');
    expect((await repository.listRecords())[0]?.context.pdf).toEqual(pdf.pdf);
  });
  it('round trips attachment evidence and keeps older records readable', async () => {
    const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());
    const attached = record({ attachments: [{ ...context(), selectedText: '---\n# source\n|a|b|\n$$x$$' }] });
    await repository.createRecord(attached);
    await repository.createRecord(record({ id: 'legacy' }));
    expect(await repository.listRecords()).toEqual(expect.arrayContaining([attached, record({ id: 'legacy' })]));
    for (const [path, text] of files.files) {
      if (text.includes('attachments:')) files.files.set(path, text.replace(/^attachments:.*$/m, 'attachments: [false]'));
    }
    expect(await repository.listRecords()).toEqual([record({ id: 'legacy' })]);
    expect(repository.getDiagnostics()).toHaveLength(1);
  });
  it('round trips explicit normal units and records alongside legacy study data', async () => {
    const repository = new MarkdownStudyRepository(new MemoryFilePort(), new MemoryStatePort());
    const state: StudyState = { version: 1, units: [
      { id: 'normal', mode: 'normal', sourcePath: '', createdAt: '2026-09-11' },
      { id: 'study', sourcePath: 'A.md', createdAt: '2026-09-11' },
    ] };
    await repository.saveState(state);
    await expect(repository.loadState()).resolves.toEqual(state);
    const main = record({ mode: 'normal', context: { ...context(), sourcePath: '', sourceName: '', selectedText: '', before: '', after: '' } });
    const quick = record({ id: 'quick', mode: 'normal', kind: 'quick', conversationId: 'side' });
    await repository.createRecord(main);
    await repository.createRecord(quick);
    await expect(repository.listRecords()).resolves.toEqual([main, quick]);
    await expect(repository.createRecord({ ...main, id: 'bad-study', mode: 'study' })).rejects.toThrow('sourcePath');
    await expect(repository.createRecord({ ...main, id: 'bad-quick', kind: 'quick' })).rejects.toThrow('sourcePath');
    await expect(repository.saveState({ version: 1, units: [{ id: 'legacy-empty', sourcePath: '', createdAt: 'today' }] })).rejects.toThrow('sourcePath');
  });

  it('round trips optional provider ownership and rejects invalid persisted providers', async () => {
    const files = new MemoryFilePort();
    const statePort = new MemoryStatePort();
    const repository = new MarkdownStudyRepository(files, statePort);
    const state: StudyState = { version: 1, units: [
      { id: 'claude-unit', sourcePath: 'A.md', createdAt: 'now', provider: 'claude' },
      { id: 'codex-unit', sourcePath: 'B.md', createdAt: 'now', provider: 'codex' },
    ] };
    await repository.saveState(state);
    await expect(repository.loadState()).resolves.toEqual(state);
    const owned = record({ provider: 'codex' });
    await repository.createRecord(owned);
    await expect(repository.listRecords()).resolves.toEqual([owned]);
    expect(files.files.get('Study Companion/record-1.md')).toContain('provider: "codex"');

    statePort.value = { version: 1, units: [{ id: 'bad', sourcePath: 'bad.md', createdAt: 'now', provider: 'other' }] };
    await expect(repository.loadState()).rejects.toBeInstanceOf(InvalidStateError);
    files.files.set('Study Companion/record-1.md', files.files.get('Study Companion/record-1.md')!.replace('provider: "codex"', 'provider: "other"'));
    await expect(repository.listRecords()).resolves.toEqual([]);
    expect(repository.getDiagnostics()).toHaveLength(1);
  });

  it('round trips adversarial Markdown without putting the answer in frontmatter', async () => {
    const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());
    const original = record({
      question: '# A heading\n```md\n---\nfrontmatter-looking text\n```\n<!-- study-companion:answer:start -->',
      answer: '## A heading\n```ts\nconst fence = "```";\n```\n---\n<!-- study-companion:question:end -->',
    });

    await repository.createRecord(original);
    const markdown = files.files.get('Study Companion/record-1.md');
    expect(markdown).toBeDefined();
    expect(markdown?.slice(0, markdown.indexOf('\n---\n'))).not.toContain('Because it does.');

    await expect(repository.listRecords()).resolves.toEqual([original]);
  });

  it('reloads user edits and changes only the visible status section', async () => {
    const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());
    await repository.createRecord(record());

    const path = 'Study Companion/record-1.md';
    const editedAnswer = 'A user edited answer with # headings and ``` fences.';
    const edited = (files.files.get(path) ?? '').replace('Because it does.', editedAnswer);
    files.files.set(path, edited.replace('unresolved', 'understood'));

    await expect(repository.listRecords()).resolves.toMatchObject([{ answer: editedAnswer, status: 'understood' }]);
    await repository.updateStatus('record-1', 'unresolved');
    await expect(repository.listRecords()).resolves.toMatchObject([{ answer: editedAnswer, status: 'unresolved' }]);
    expect(files.files.get(path)).toContain(editedAnswer);
  });

  it('refuses to update a missing record without creating it', async () => {
    const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());

    await expect(repository.updateStatus('missing', 'understood')).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(files.files.size).toBe(0);
  });

  it('serializes concurrent creates so an id is written at most once', async () => {
    const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());
    const first = record({ answer: 'first' });
    const second = record({ answer: 'second' });

    const results = await Promise.allSettled([repository.createRecord(first), repository.createRecord(second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected.map(result => result.reason)).toEqual([expect.any(RecordAlreadyExistsError)]);
    await expect(repository.listRecords()).resolves.toMatchObject([{ answer: 'first' }]);
  });

  it('rejects path traversal in folders and record ids', async () => {
    const files = new MemoryFilePort();
    expect(() => new MarkdownStudyRepository(files, new MemoryStatePort(), '../outside')).toThrow(InvalidStoragePathError);
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());

    await expect(repository.createRecord(record({ id: '../escape' }))).rejects.toBeInstanceOf(InvalidStoragePathError);
    await expect(repository.updateStatus('folder/escape', 'understood')).rejects.toBeInstanceOf(InvalidStoragePathError);
    expect(files.files.size).toBe(0);
  });

  it('rejects malformed state instead of trusting a cast', async () => {
    const state = new MemoryStatePort({ version: 1, units: [{ id: '../escape', sourcePath: 'note.md', createdAt: 'now' }] });
    const repository = new MarkdownStudyRepository(new MemoryFilePort(), state);

    await expect(repository.loadState()).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('skips ordinary Markdown and malformed plugin records without blocking the list', async () => {
    const files = new MemoryFilePort();
    files.folders.add('Study Companion');
    files.files.set('Study Companion/ordinary.md', '# A note\n---\nnot a record');
    files.files.set('Study Companion/plugin.md', '---\nstudyCompanionVersion: 1\n---\n');
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());

    await expect(repository.listRecords()).resolves.toEqual([]);
    expect(repository.getDiagnostics()).toMatchObject([{ code: 'malformed-record', path: 'Study Companion/plugin.md' }]);
  });

  it('keeps valid records available when another plugin record is malformed', async () => {
    const files = new MemoryFilePort();
    const repository = new MarkdownStudyRepository(files, new MemoryStatePort());
    await repository.createRecord(record());
    files.files.set('Study Companion/broken.md', '---\nstudyCompanionVersion: 1\n---\n');

    await expect(repository.listRecords()).resolves.toEqual([record()]);
    expect(repository.getDiagnostics()).toMatchObject([{ code: 'malformed-record', path: 'Study Companion/broken.md' }]);
    expect(files.files.get('Study Companion/broken.md')).toBe('---\nstudyCompanionVersion: 1\n---\n');
  });
});

it('round-trips bounded tool evidence independently of answer Markdown and source selection', async () => {
  const files = new MemoryFilePort();
  const state = new MemoryStatePort();
  const saved = record({ requestMetrics: { modelCalls: 1, reportedCalls: 0, inputReportedCalls: 0, outputReportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, elapsedMs: 5, phases: { preparation: 0, retrieval: 0, web: 0, answer: 1 } }, toolTrace: [{ evidenceId: 'S1', version: { mtime: 1, size: 20 }, endLine: 13, tool: 'Read', input: 'notes/related.md', path: 'notes/related.md', startLine: 12, text: '12: # 相关原文\n13: 文本' }] });
  await new MarkdownStudyRepository(files, state).createRecord(saved);
  const restored = (await new MarkdownStudyRepository(files, state).listRecords())[0]!;
  expect(restored.toolTrace).toEqual(saved.toolTrace);
  expect(restored.requestMetrics).toEqual(saved.requestMetrics);
  expect(restored.context).toEqual(saved.context);
  expect(restored.answer).toEqual(saved.answer);
});

it('round-trips optional followup references and rejects malformed metadata without changing legacy records', async () => {
  const files = new MemoryFilePort(); const state = new MemoryStatePort();
  const repository = new MarkdownStudyRepository(files, state);
  const saved = record({ followup: { kind: 'example', recordId: 'original' }, question: '举例说明' });
  await repository.createRecord(saved);
  expect((await new MarkdownStudyRepository(files, state).listRecords())[0]).toEqual(saved);
  await expect(repository.createRecord(record({ id: 'bad', followup: { kind: 'invalid', recordId: 'original' } as never }))).rejects.toThrow('followup');
});

it('round trips multi-topic lesson metadata through Markdown', async () => {
  const files = new MemoryFilePort();
  const repo = new MarkdownStudyRepository(files, new MemoryStatePort(), 'Study');
  const taught = record({ context: { ...context(), sourcePath: 'Course.pdf', pdf: { pageCount: 2, pages: [1, 2], emptyPages: [] } },
    lesson: { kind: 'teach', planId: 'plan', topicKey: 'one', topicKeys: ['one', 'two'] } });
  await repo.createRecord(taught);
  expect((await repo.listRecords())[0]!.lesson).toEqual(taught.lesson);
});
