import { expect, it } from 'vitest';
import type { ContextCache, DocumentPage } from '../../src/core/context';
import type { BackendRequest, SourceContext, StudyBackend, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';
import { CachedDocumentLibrary } from '../../src/application/DocumentLibrary';
import { outlineBatches, pageBatches, planLongPdf, resolveLongPdf } from '../../src/application/long-pdf';
import { estimateTokens } from '../../src/application/context-budget';
import { parseLessonOutline, deriveLesson } from '../../src/application/lesson';
import { NotebookSupplementGenerator } from '../../src/application/notebook-supplement';
import { StudyController } from '../../src/application/StudyController';
import { budgetEvidence } from '../../src/application/evidence-budget';
import { organizeChapters } from '../../src/application/lesson-chapters';

class Cache implements ContextCache {
  values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async set(key: string, value: string) { this.values.set(key, value); }
}

it('uses bilingual planning to retrieve English original pages 80 and 90 for a Chinese question', async () => {
  const f = await libraryFixture();
  await f.library.put(source.pdf!.sha256!, { page: 80, text: 'A conditional language model predicts the probability of a word given context.' });
  await f.library.put(source.pdf!.sha256!, { page: 90, text: 'Mobile Agent https://github.com/X-PLUG/MobileAgent' });
  const model = backend(() => JSON.stringify({ queries: ['language model', 'Mobile Agent', '模型生成不可作为证据'], pages: [90] }));
  const services = { ...f.services, semanticPlanning: true, topics: [
    { key: 'lm', title: '条件语言模型', objective: '定义', pages: [79, 80] },
    { key: 'agent', title: '从大模型到智能体', objective: '案例', pages: [89, 90] },
  ] };
  const result = await resolveLongPdf(source, '语言模型和手机智能体有什么关系？', [], services, model,
    { requestId: 'cross', prompt: '', signal: signal() }, () => {});
  expect(result.pdf?.pages).toEqual([80, 90]);
  expect(result.selectedText).toContain('conditional language model');
  expect(result.selectedText).not.toContain('模型生成不可作为证据');
  expect(model.calls[0]?.prompt).toContain('条件语言模型');
});

it('preserves every topic identity through chapter grouping and rejects duplicate allocation', async () => {
  const text = '## 1. 课程安排\n页码：1\n目标：了解安排\n\n## 2. 语言模型\n页码：80\n目标：理解概率';
  const topics = parseLessonOutline(text, source);
  const model = backend(() => JSON.stringify([{ title: '课程信息', category: '课程安排', topics: [0] }, { title: '语言建模', category: '知识内容', topics: [1] }]));
  const request = { requestId: 'group', prompt: '', signal: signal() };
  const grouped = await organizeChapters(topics, model, request, undefined, 'config');
  expect(parseLessonOutline(grouped, source).map(t => t.key)).toEqual(topics.map(t => t.key));
  expect(parseLessonOutline(grouped, source)[1]?.chapter).toBe('语言建模');
  await expect(organizeChapters(topics, backend(() => JSON.stringify([{ title: '重复', category: '知识内容', topics: [0, 0] }])), request, undefined, '')).rejects.toThrow('遗漏或重复');
});

it('allocates one evidence budget across multiple sources without dropping their final segments', async () => {
  const seen = new Set<string>();
  const model = backend(request => {
    for (const match of request.prompt.matchAll(/END_[A-D]/gu)) seen.add(match[0]);
    return '带来源的摘要';
  });
  const contexts = ['A', 'B', 'C', 'D'].map(name => ({ ...source, sourcePath: `${name}.pdf`,
    selectedText: `${'原文定义条件'.repeat(6000)} END_${name}` }));
  const result = await budgetEvidence(contexts[0]!, contexts.slice(1), model,
    { requestId: 'budget', prompt: '比较各资料', signal: signal() }, new Cache(), 'model', () => {});
  expect(seen).toEqual(new Set(['END_A', 'END_B', 'END_C', 'END_D']));
  expect(result.attachments).toHaveLength(3);
  expect(estimateTokens(JSON.stringify(result))).toBeLessThan(40_000);
  expect(result.context.selectedText).toContain('非逐字原文');
});

it('rebuilds a normal-chat prompt with resolved PDF attachment evidence', async () => {
  const f = await libraryFixture(); const repo = new Repository();
  const model = backend(() => '回答'); let id = 0;
  const controller = new StudyController(model, repo, () => `attachment-${++id}`, undefined, () => 'claude', undefined, f.services);
  await controller.initialize(); const unit = await controller.startNormal('claude');
  const empty = { ...source, sourcePath: '', selectedText: '', pdf: undefined };
  await controller.submit({ unitId: unit.id, kind: 'main', question: 'SECTION_299', context: empty, attachments: [source] });
  expect(model.calls.at(-1)?.prompt).toContain('SECTION_299');
  expect(model.calls.at(-1)?.prompt.endsWith(JSON.stringify({ currentQuestion: 'SECTION_299' }))).toBe(true);
  expect(model.calls.at(-1)?.prompt).not.toContain('已导入 300 页');
  expect(repo.records.at(-1)?.state).toBe('complete');
});
const signal = () => new AbortController().signal;
const source: SourceContext = { sourcePath: 'Book.pdf', sourceName: 'Book', selectedText: '已导入 300 页', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 },
  pdf: { indexed: true, sha256: 'a'.repeat(64), pageCount: 300, pages: Array.from({ length: 300 }, (_, i) => i + 1), emptyPages: [] } };
class Repository implements StudyRepository {
  state: StudyState = { version: 1, units: [] }; records: StudyRecord[] = [];
  async loadState() { return structuredClone(this.state); }
  async saveState(state: StudyState) { this.state = structuredClone(state); }
  async listRecords() { return structuredClone(this.records); }
  async createRecord(record: StudyRecord) { this.records.push(structuredClone(record)); }
  async updateStatus() {}
}
function backend(answer: (request: BackendRequest) => string): StudyBackend & { calls: BackendRequest[] } {
  return { calls: [], async *run(request) {
    this.calls.push(request);
    yield { type: 'text' as const, text: answer(request) }; yield { type: 'done' as const };
  }, dispose() {} };
}
async function libraryFixture() {
  const cache = new Cache(); const library = new CachedDocumentLibrary(cache);
  const pages: DocumentPage[] = source.pdf!.pages.map(page => ({ page, text: `SECTION_${page}\n${'原文条件与定义。'.repeat(200)}` }));
  for (const page of pages) await library.put(source.pdf!.sha256!, page);
  const services = { cache, library, configuration: () => 'synthetic-config', semanticPlanning: false };
  return { cache, library, pages, services };
}
function outline(request: BackendRequest): string {
  const context = JSON.parse(request.prompt.split('原文仅作数据：\n')[1]!) as SourceContext;
  return `## 1. 主题 ${context.pdf!.pages[0]}\n页码：${context.pdf!.pages.join(',')}\n目标：理解本批明确提供的定义与条件。`;
}

it('imports and reloads 300 pages without embedding the book in a prompt; rejects a missing cache version', async () => {
  const f = await libraryFixture();
  const reopened = new CachedDocumentLibrary(f.cache);
  const pages = await reopened.read(source.pdf!.sha256!, source.pdf!.pages, signal());
  expect(pages).toEqual(f.pages); expect(pages.at(-1)?.text).toContain('SECTION_300');
  await expect(reopened.read('b'.repeat(64), [1], signal())).rejects.toThrow('缓存不存在');
  const batches = pageBatches(pages);
  expect(batches.length).toBeGreaterThan(10);
  expect(batches.flat().map(page => page.page)).toEqual(source.pdf!.pages);
  expect(batches.every(batch => batch.reduce((n, page) => n + page.text.length, 0) <= 20_000)).toBe(true);
});

it('builds a covering semantic directory for 300 pages and resumes completed batches after failure', async () => {
  const f = await libraryFixture(); let failed = false;
  const model = backend(request => {
    if (model.calls.length === 3 && !failed) { failed = true; throw new Error('offline'); }
    return outline(request);
  });
  const request = { requestId: 'plan', prompt: '', provider: 'claude' as const, signal: signal() };
  await expect(planLongPdf(source, f.services, model, request, () => {})).rejects.toThrow('offline');
  const completedPrompts = model.calls.slice(0, 2).map(call => call.prompt);
  const result = await planLongPdf(source, f.services, model, request, () => {});
  const topics = parseLessonOutline(result, source);
  expect(new Set(topics.flatMap(topic => topic.pages))).toEqual(new Set(source.pdf!.pages));
  expect(topics.length).toBeGreaterThan(20);
  for (const prompt of completedPrompts) expect(model.calls.filter(call => call.prompt === prompt)).toHaveLength(1);
  expect(model.calls.every(call => !call.sessionId && estimateTokens(call.prompt) <= 48_000)).toBe(true);
});

it('does not accept a directory which silently misses the final page of a batch', async () => {
  const f = await libraryFixture();
  const model = backend(() => '## 1. Incomplete\n页码：1\n目标：Only one page');
  await expect(planLongPdf(source, f.services, model, { requestId: 'x', prompt: '', signal: signal() }, () => {})).rejects.toThrow('遗漏');
});

it('plans a typical 40-slide document in one call without a second chapter pass', async () => {
  const pages = Array.from({ length: 40 }, (_, i) => ({ page: i + 1, text: `TOPIC_${i + 1}\n${'A definition and worked example. '.repeat(22)}` }));
  const context = { ...source, pdf: { ...source.pdf!, pageCount: 40, pages: pages.map(p => p.page) } };
  const cache = new Cache();
  const services = { library: { read: async () => pages }, cache, configuration: () => 'compact' };
  const model = backend(outline);
  const request = { requestId: 'compact', prompt: '', signal: signal() };
  expect(outlineBatches(pages)).toHaveLength(1);
  const result = await planLongPdf(context, services, model, request, () => {});
  expect(model.calls).toHaveLength(1);
  expect(new Set(parseLessonOutline(result, context).flatMap(t => t.pages))).toEqual(new Set(context.pdf.pages));
  expect(estimateTokens(model.calls[0]!.prompt)).toBeLessThan(48_000);
  await planLongPdf(context, services, model, request, () => {});
  expect(model.calls).toHaveLength(1);
});

it('persists paper identification in the same cached outline call', async () => {
  const pages = [{ page: 1, text: 'Synthetic research manuscript: abstract, method, controlled experiment, limitations.' }];
  const context = { ...source, pdf: { ...source.pdf!, pageCount: 1, pages: [1], emptyPages: [] } };
  const services = { library: { read: async () => pages }, cache: new Cache(), configuration: () => 'paper' };
  const model = backend(() => '资料类型：论文\n\n## 1. 研究方法\n页码：1\n目标：理解假设与证据。');
  const request = { requestId: 'paper', prompt: '', signal: signal() };
  const answer = await planLongPdf(context, services, model, request, () => {});
  expect(answer.startsWith('资料类型：论文')).toBe(true);
  expect(answer).toContain('阅读章节');
  expect(parseLessonOutline(answer, context)[0]!.pages).toEqual([1]);
  expect(await planLongPdf(context, services, model, request, () => {})).toBe(answer);
  expect(model.calls).toHaveLength(1);
});

it('selects current-topic original text and retrieves a distant topic for a cross-document question', async () => {
  const f = await libraryFixture(); const model = backend(() => 'unused');
  const request = { requestId: 'question', prompt: '', signal: signal() };
  const context = await resolveLongPdf(source, '解释这个定义', [200, 201], f.services, model, request, () => {});
  expect(context.pdf?.pages).toEqual([200, 201]);
  expect(context.selectedText).toContain('SECTION_200'); expect(context.selectedText).not.toContain('SECTION_1\n');
  const distant = await resolveLongPdf(source, 'SECTION_299', [], f.services, model, request, () => {});
  expect(distant.pdf?.pages).toContain(299); expect(distant.selectedText.length).toBeLessThan(30_000);
  expect(model.calls).toHaveLength(0);
});

it('uses all batches for a whole-book summary rather than selecting a few pages', async () => {
  const f = await libraryFixture(); const seen = new Set<number>();
  const model = backend(request => {
    for (const match of request.prompt.matchAll(/SECTION_(\d+)/gu)) seen.add(Number(match[1]));
    return '本批摘要，定义与条件需要回查原文。';
  });
  const result = await resolveLongPdf(source, '总结全文', [], f.services, model, { requestId: 's', prompt: '', signal: signal() }, () => {});
  expect(seen).toEqual(new Set(source.pdf!.pages)); expect(result.selectedText.length).toBeLessThan(30_000);
  expect(result.selectedText).toContain('不是逐字原文');
});

it('summarizes every page of an oversized teaching topic without including unrelated chapters', async () => {
  const f = await libraryFixture(); const seen = new Set<number>();
  const preferred = Array.from({ length: 40 }, (_, index) => index + 201);
  const model = backend(request => {
    for (const match of request.prompt.matchAll(/SECTION_(\d+)/gu)) seen.add(Number(match[1]));
    return '本批主题摘要，精确细节需回查原文。';
  });
  const result = await resolveLongPdf(source, '讲解本主题', preferred, f.services, model,
    { requestId: 'topic', prompt: '', signal: signal() }, () => {});
  expect(seen).toEqual(new Set(preferred));
  expect(result.pdf?.pages).toEqual(preferred);
  expect(result.selectedText).toContain('不是逐字原文');
  expect(model.calls.length).toBeGreaterThan(1);
});

it('splits a single 150000-character answer and a large notebook, resumes batches and preserves all source segments', async () => {
  const repo = new Repository();
  const unit = { id: 'u', sourcePath: 'Book.pdf', createdAt: 'now', provider: 'claude' as const };
  const answer = Array.from({ length: 160 }, (_, i) => `UNIQUE_${i}\n${'知识点'.repeat(400)}`).join('\n');
  repo.records = [{ id: 'long', unitId: 'u', kind: 'main', conversationId: 'main:u', context: source, question: '整理', answer,
    createdAt: 'now', state: 'complete', status: 'unresolved' }];
  const cache = new Cache(); let fail = true;
  const seen = new Set<number>();
  const model = backend(request => {
    if (model.calls.length === 3 && fail) { fail = false; throw new Error('offline'); }
    const payload = JSON.parse(request.prompt.split('\n\n').at(-1)!) as { records: { recordId: string; answer: string }[] };
    for (const record of payload.records) for (const match of record.answer.matchAll(/UNIQUE_(\d+)/gu)) seen.add(Number(match[1]));
    return JSON.stringify(payload.records.map(record => ({ recordId: record.recordId, markdown: `本批笔记 ${seen.size}` })));
  });
  const existing = [{ recordId: 'other', kind: 'raw' as const, markdown: '旧笔记'.repeat(100_000) }];
  const generate = () => new NotebookSupplementGenerator(repo, model, cache).generate(unit, existing, signal());
  await expect(generate()).rejects.toThrow('offline');
  const first = model.calls[0]!.prompt;
  const result = await generate();
  expect(result.entries).toHaveLength(1); expect(result.entries[0]?.recordId).toBe('long');
  expect(seen.size).toBe(160); expect(model.calls.filter(call => call.prompt === first)).toHaveLength(1);
  expect(model.calls.every(call => call.prompt.length < 45_000)).toBe(true);
  const previousCalls = model.calls.length;
  repo.records = []; expect((await generate()).entries).toEqual([]); expect(model.calls).toHaveLength(previousCalls);
});

it('routes long PDF planning and teaching end to end without putting the full book into the answer session', async () => {
  const f = await libraryFixture(); const repo = new Repository();
  const model = backend(request => request.prompt.includes('原文仅作数据：') ? outline(request) : '本主题讲解。');
  let id = 0;
  const controller = new StudyController(model, repo, () => `r${++id}`, () => new Date().toISOString(), () => 'claude', undefined, f.services);
  await controller.initialize(); const unit = await controller.startStudy(source);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: '生成目录' });
  const current = controller.snapshot().units[0]!;
  const lesson = deriveLesson(current, repo.records)!;
  expect(lesson.topics.length).toBeGreaterThan(20);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: '开始讲解' });
  expect(repo.records.at(-1)?.state).toBe('complete');
  expect(repo.records.at(-1)?.requestEvidence?.pdf?.pages).toEqual(lesson.next?.pages);
  expect(model.calls.at(-1)?.sessionId).toBeUndefined();
  expect(model.calls.at(-1)!.prompt).not.toContain('SECTION_300');
  expect(deriveLesson(controller.snapshot().units[0]!, repo.records)?.completed).toHaveLength(1);
});

it('manages over-100000-character history, isolates sides and respects reset and deletion boundaries', async () => {
  const f = await libraryFixture(); const repo = new Repository();
  const model = backend(request => request.prompt.startsWith('更新学习状态摘要') ? '历史摘要：学习目标与未解决问题，非原文证据。' : 'Final');
  let id = 100;
  const controller = new StudyController(model, repo, () => `id${++id}`, undefined, () => 'claude', undefined, f.services);
  await controller.initialize();
  const context = { ...source, pdf: undefined, sourcePath: 'A.md', selectedText: '原文' };
  const unit = await controller.startStudy(context);
  repo.records = Array.from({ length: 12 }, (_, index) => ({ id: `old${index}`, unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`,
    context, question: `HISTORY_${index}`, answer: '历史讨论'.repeat(2500), createdAt: `2026-01-${String(index + 1).padStart(2, '0')}`, state: 'complete', status: 'unresolved' }));
  repo.records.push({ ...repo.records[0]!, id: 'side', kind: 'quick', conversationId: 'quick:side', question: 'SIDE_SECRET' });
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: '继续' });
  expect(repo.records.at(-1)?.state).toBe('complete'); expect(repo.records.at(-1)?.contextManaged).toBe(true);
  expect(model.calls.every(call => !call.prompt.includes('SIDE_SECRET'))).toBe(true);
  expect(model.calls.at(-1)?.sessionId).toBeUndefined();
  expect(estimateTokens(model.calls.at(-1)!.prompt)).toBeLessThan(64_000);
  await controller.resetMainSession(unit.id);
  const before = model.calls.length;
  await controller.submit({ unitId: unit.id, kind: 'main', context, question: '全新问题' });
  expect(model.calls.slice(before).every(call => !call.prompt.includes('HISTORY_'))).toBe(true);
  repo.records = repo.records.filter(r => r.kind === 'quick');
  const restart = new StudyController(model, repo, () => `id${++id}`, undefined, () => 'claude', undefined, f.services);
  await restart.initialize();
  const count = model.calls.length;
  await restart.submit({ unitId: unit.id, kind: 'main', context, question: '问答已移除' });
  expect(model.calls.slice(count).every(call => !call.prompt.includes('HISTORY_'))).toBe(true);
});

it('answers a social turn beside an indexed PDF without reading pages or running preparation', async () => {
  const repo = new Repository(); const model = backend(() => '你好'); let reads = 0;
  const services = { library: { read: async () => { reads++; throw new Error('must not read'); } }, configuration: () => 'test' };
  const controller = new StudyController(model, repo, undefined, undefined, undefined, undefined, services);
  await controller.initialize(); const unit = await controller.startStudy(source);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: '你好' });
  expect(reads).toBe(0); expect(model.calls).toHaveLength(1);
  expect(model.calls[0]!.prompt).not.toContain('已导入 300 页');
  expect(repo.records[0]).toMatchObject({ state: 'complete', context: source });
  expect(controller.snapshot().units[0]!.sourcePath).toBe('Book.pdf');
  await controller.dispose();
});

it('preserves rejected outline output without activating a plan or automatically retrying', async () => {
  const repo = new Repository();
  const answer = '## 1. 未完成的主题\n页码：1\n缺少学习目标。';
  const model = backend(() => answer);
  const services = { library: { read: async () => [{ page: 1, text: '原文' }] }, configuration: () => 'invalid-output-test' };
  const controller = new StudyController(model, repo, undefined, undefined, undefined, undefined, services);
  await controller.initialize(); const unit = await controller.startStudy(source);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: '生成目录', lesson: { kind: 'plan' } });
  expect(model.calls).toHaveLength(1);
  expect(repo.records[0]).toMatchObject({ state: 'error', answer, error: expect.stringContaining('生成内容已保留') });
  expect(controller.snapshot().units[0]!.lesson).toBeUndefined();
  await controller.dispose();
});

it('keeps a concise example request scoped to the clicked answer evidence after PDF prompt rebuilding', async () => {
  const f = await libraryFixture(); const repo = new Repository();
  const model = backend(() => '一个具体例子'); let id = 0;
  const controller = new StudyController(model, repo, () => `followup-${++id}`, undefined, () => 'claude', undefined, f.services);
  await controller.initialize(); const unit = await controller.startStudy(source);
  const original: StudyRecord = { id: 'original', unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`, context: source,
    requestEvidence: { ...source, selectedText: 'SECTION_299 原文', pdf: { ...source.pdf!, indexed: undefined, pages: [299] } },
    question: '解释 SECTION_299', answer: '**已有回答**', createdAt: '2026-01-01', status: 'unresolved', state: 'complete', provider: 'claude' };
  repo.records.push(original);
  await controller.explainAgain(original.id, true);
  expect(repo.records.at(-1)).toMatchObject({ question: '举例说明', state: 'complete', requestEvidence: { pdf: { pages: [299] } } });
  expect(repo.records.at(-1)!.context.pdf!.pages).toHaveLength(300);
  expect(model.calls.at(-1)!.prompt).toContain('只举一个具体例子');
  expect(model.calls.at(-1)!.prompt).toContain('**已有回答**');
  expect(model.calls.at(-1)!.prompt).toContain('SECTION_299');
  expect(model.calls.at(-1)!.prompt.endsWith(JSON.stringify({ currentQuestion: '举例说明' }))).toBe(true);
});

it('direct and auto followups retain managed history without rereading PDF pages', async () => {
  const f = await libraryFixture(); const repo = new Repository(); let id = 0;
  const model = backend(() => '记忆标记：蓝色月亮');
  const controller = new StudyController(model, repo, () => `policy-${++id}`, undefined, () => 'claude', undefined, f.services);
  await controller.initialize(); const unit = await controller.startStudy(source);
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, question: 'SECTION_299' });
  expect(repo.records[0]?.contextManaged).toBe(true);
  const calls = model.calls.length;
  f.library.read = async () => { throw new Error('must not read PDF'); };
  for (const answerPolicy of ['direct', 'auto'] as const) {
    await controller.submit({ unitId: unit.id, kind: 'main', context: { ...source, pdf: undefined, selectedText: '' }, question: '再解释一下刚才的记忆标记', answerPolicy });
    expect(repo.records.at(-1)?.state).toBe('complete');
    expect(repo.records.at(-1)?.evidenceMode).toBe('conversation');
    expect(model.calls.at(-1)?.prompt).toContain('蓝色月亮');
    expect(model.calls.at(-1)?.sessionId).toBeUndefined();
    expect(repo.records.at(-1)?.conversationId).toBe(`main:${unit.id}`);
  }
  expect(model.calls.length - calls).toBe(2);
});

it('keeps the selected answer quote and scoped history while skipping all PDF preparation calls', async () => {
  const repo = new Repository(); const model = backend(() => '承接原回答解释'); let reads = 0;
  const services = { library: { read: async () => { reads++; throw new Error('unexpected PDF read'); } }, configuration: () => 'quote-test' };
  const controller = new StudyController(model, repo, undefined, undefined, () => 'claude', undefined, services);
  await controller.initialize(); const unit = await controller.startStudy(source);
  const original: StudyRecord = { id: 'quoted-answer', unitId: unit.id, kind: 'main', conversationId: `main:${unit.id}`, context: source,
    question: '原问题', answer: '原对话历史标记', createdAt: '2026-01-01', status: 'unresolved', state: 'complete', provider: 'claude', contextManaged: true };
  repo.records.push(original, { ...original, id: 'other', kind: 'quick', conversationId: 'quick:other', answer: 'OTHER_CONVERSATION' });
  const quote = { ...source, pdf: undefined, selectedText: '本次明确选中的回答片段', answerRecordId: original.id };
  await controller.submit({ unitId: unit.id, kind: 'main', context: source, attachments: [quote],
    question: '请解释我引用的这句话', answerPolicy: 'auto' });
  expect(reads).toBe(0); expect(model.calls).toHaveLength(1);
  expect(model.calls[0]!.prompt).toContain(quote.selectedText);
  expect(model.calls[0]!.prompt).toContain('原对话历史标记');
  expect(model.calls[0]!.prompt).toContain('模型回答片段');
  expect(model.calls[0]!.prompt).not.toContain('OTHER_CONVERSATION');
  expect(repo.records.at(-1)).toMatchObject({ state: 'complete', evidenceMode: 'conversation', answerPolicy: 'auto', attachments: [quote],
    conversationId: original.conversationId, requestMetrics: { modelCalls: 1, phases: { preparation: 0 } } });
  await controller.dispose();
});
