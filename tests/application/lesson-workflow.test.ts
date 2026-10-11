import { expect, it, vi } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import { deriveLesson } from '../../src/application/lesson';
import { markdownLessonContext } from '../../src/core/markdown';
import type { BackendEvent, BackendRequest, SourceContext, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';

const pdf: SourceContext = { sourcePath: 'Course.pdf', sourceName: 'Course', selectedText: '第1页：平均速度。第2页：瞬时速度。',
  before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 4, pages: [1, 2], emptyPages: [] } };
const outline = '仅依据已选页面，图表可能缺失。\n\n## 1. 平均速度\n页码：1\n目标：理解平均速度。\n\n## 2. 瞬时速度\n页码：2\n目标：理解某时刻的速度。';

it('keeps Markdown learning on its saved snapshot through edits, followups, explicit continuation and reload', async () => {
  const source = markdownLessonContext({ ...pdf, pdf: undefined, sourcePath: 'Course.md' }, '# 速度\n原始定义与例子', 'document');
  const f = await setup(source);
  f.control.answer = '## 1. 定义\n目标：理解定义。\n\n## 2. 例子\n目标：应用定义。';
  await f.plan();
  expect(f.progress()!.topics).toHaveLength(2);
  expect(f.requests[0]!.sessionId).toBeUndefined();
  expect(f.requests[0]!.prompt).toContain('原始定义与例子');
  const live = { ...source, markdown: undefined, selectedText: '后来的选区和修改' };
  expect(deriveLesson(f.unit, f.records, live)?.plan.id).toBe(f.progress()!.plan.id);
  f.control.answer = '定义的讲解。';
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: live, question: '继续' });
  expect(f.records.at(-1)?.context.selectedText).toBe(source.selectedText);
  expect(f.progress()!.completed).toHaveLength(1);
  expect(f.requests.at(-1)!.prompt).toContain('Markdown 正文快照');
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: live, question: '根据选区解释这个定义为什么重要？', answerPolicy: 'source' });
  expect(f.records.at(-1)?.lesson).toBeUndefined();
  expect(f.progress()!.completed).toHaveLength(1);
  expect(f.requests.at(-1)!.prompt).toContain('后来的选区和修改');
  expect(f.requests.at(-1)!.prompt).not.toContain('实际文件页码');
  const resumed = f.create(); await resumed.initialize();
  expect(f.progress(resumed)!.completed).toHaveLength(1);
  await resumed.dispose(); await f.app.dispose();
});

it('retains the previous Markdown directory on failed/cancelled replanning and replaces it only on success', async () => {
  const source = markdownLessonContext({ ...pdf, pdf: undefined, sourcePath: 'Course.md' }, '原正文', 'selection');
  const f = await setup(source); f.control.answer = '## 1. 原主题\n目标：理解。';
  await f.plan(); const original = f.progress()!.plan.id;
  f.control.answer = '不是有效目录'; await f.plan();
  expect(f.progress()!.plan.id).toBe(original);
  expect(f.records.at(-1)).toMatchObject({ state: 'error', answer: '不是有效目录' });
  f.control.hold = true; const pending = f.plan();
  await vi.waitFor(() => expect(f.app.snapshot().running).toHaveLength(1));
  f.app.cancel(f.app.snapshot().running[0]!.requestId); await pending;
  expect(f.progress()!.plan.id).toBe(original);
  f.control.hold = false; f.control.answer = '## 1. 新主题\n目标：理解新内容。'; await f.plan();
  expect(f.progress()!.plan.id).not.toBe(original);
  expect(f.progress()!.completed).toEqual([]);
  expect(f.records.some(record => record.id === original)).toBe(true);
  f.records.splice(f.records.findIndex(record => record.id === f.progress()!.plan.id), 1);
  await f.app.refreshRecords(); expect(f.progress()).toBeNull();
  await f.app.dispose();
});

async function setup(source = pdf) {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [];
  const requests: BackendRequest[] = [];
  const control = { answer: outline, failCreate: false, failRun: false, hold: false };
  const repository: StudyRepository = {
    async loadState() { return structuredClone(state); },
    async saveState(next) { state = structuredClone(next); },
    async listRecords() { return structuredClone(records); },
    async createRecord(record) { if (control.failCreate) throw new Error('disk full'); records.push(structuredClone(record)); },
    async updateStatus() {},
  };
  const backend = { async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
    requests.push(request);
    yield { type: 'session', sessionId: 'course-session' };
    if (control.hold) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    if (request.signal.aborted) return;
    yield { type: 'text', text: control.answer };
    if (control.failRun) throw new Error('offline');
    yield { type: 'done' };
  }, dispose() {} };
  let id = 0;
  const create = () => new StudyController(backend, repository, () => `id-${++id}`, () => new Date(1_800_000_000_000 + id * 1000).toISOString());
  const app = create(); await app.initialize();
  const unit = await app.startStudy(source);
  const progress = (controller = app) => deriveLesson(controller.snapshot().units.find(item => item.id === unit.id)!, controller.snapshot().records, source);
  const plan = () => app.submit({ unitId: unit.id, kind: 'main', context: source, question: '按主题讲解', lesson: { kind: 'plan' } });
  const teach = () => { const lesson = progress()!; return app.submit({ unitId: unit.id, kind: 'main', context: source, question: '讲解第一主题',
    lesson: { kind: 'teach', planId: lesson.plan.id, topicKey: lesson.next!.key } }); };
  return { app, unit, records, requests, control, create, progress, plan, teach };
}

it('plans once, teaches one topic, and keeps normal followups at the current topic in the same main session', async () => {
  const f = await setup(); await f.plan();
  expect(f.progress()!.completed).toEqual([]);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]!.prompt).toContain('本次只生成大纲');
  expect(f.requests[0]!.prompt).toContain('范围仅限实际文件页码：1,2');
  f.control.answer = '平均速度是总路程与总时间的比值。'; await f.teach();
  const before = f.progress()!;
  expect(before.current!.title).toBe('平均速度');
  expect(before.next!.title).toBe('瞬时速度');
  expect(f.requests[1]!.sessionId).toBe('course-session');
  expect(f.requests[1]!.prompt).toContain('只讲这个主题');
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '举个例子' });
  expect(f.requests[2]!.prompt).toContain('当前讲解主题：平均速度');
  expect(f.progress()!.completed).toEqual(before.completed);
  expect(f.records[2]!.lesson).toBeUndefined();
  await f.app.dispose();
});

it('restores ordering, skipped topics and current position, and respects edited or removed Markdown', async () => {
  const f = await setup(); await f.plan(); f.control.answer = '讲解'; await f.teach();
  const p = f.progress()!;
  await f.app.updateLesson(f.unit.id, { planId: p.plan.id, order: [...p.topics].reverse().map(topic => topic.key), skipped: [p.next!.key] });
  await f.app.dispose(); const restored = f.create(); await restored.initialize();
  const resumed = f.progress(restored)!;
  expect(resumed.current!.title).toBe('平均速度');
  expect(resumed.topics[0]!.title).toBe('瞬时速度');
  expect(resumed.next).toBeUndefined();
  f.records[0]!.answer = outline.replace('理解平均速度。', '修改后的学习目标。');
  await restored.refreshRecords();
  expect(f.progress(restored)!.completed).toEqual([]);
  f.records.splice(0, 1); await restored.refreshRecords();
  expect(f.progress(restored)).toBeNull();
  await restored.dispose();
});

it.each(['cancel', 'error', 'unsaved', 'empty'] as const)('does not advance a topic on %s and retains any received answer', async outcome => {
  const f = await setup(); await f.plan(); f.control.answer = outcome === 'empty' ? '' : '部分讲解';
  f.control.hold = outcome === 'cancel'; f.control.failCreate = outcome === 'unsaved'; f.control.failRun = outcome === 'error';
  const running = f.teach();
  if (outcome === 'cancel') {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.app.cancel(f.app.snapshot().running[0]!.requestId);
  }
  await running;
  expect(f.progress()!.completed).toEqual([]);
  const record = f.app.snapshot().records.at(-1)!;
  if (outcome === 'unsaved') expect(record).toMatchObject({ answer: '部分讲解', unsaved: true });
  else expect(record.state).toBe(outcome === 'cancel' ? 'cancelled' : 'error');
  await f.app.dispose();
});

it('rejects invalid generated page ranges without activating a plan or automatically retrying', async () => {
  const f = await setup(); f.control.answer = outline.replace('页码：1', '页码：3'); await f.plan();
  expect(f.records[0]!.state).toBe('error');
  expect(f.records[0]!.answer).toContain('页码：3');
  expect(f.progress()).toBeNull(); expect(f.requests).toHaveLength(1);
  await f.app.dispose();
});

it('maps an explicit typed next-topic command to one teaching action, while clarification stays on the same topic', async () => {
  const f = await setup();
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '按主题讲解' });
  expect(f.progress()).not.toBeNull();
  f.control.answer = '讲解';
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '开始讲解' });
  expect(f.progress()!.completed).toHaveLength(1);
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '继续解释刚才的例子' });
  expect(f.progress()!.completed).toHaveLength(1);
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '下一节' });
  expect(f.progress()!.completed).toHaveLength(2);
  expect(f.progress()!.next).toBeUndefined(); expect(f.requests).toHaveLength(4);
  await f.app.dispose();
});

it('rejects stale plans, changed evidence, normal mode and Quick Ask lesson actions before backend dispatch', async () => {
  const f = await setup(); await f.plan(); const p = f.progress()!;
  const input = { unitId: f.unit.id, kind: 'main' as const, context: pdf, question: '继续',
    lesson: { kind: 'teach' as const, planId: p.plan.id, topicKey: p.next!.key } };
  await expect(f.app.submit({ ...input, context: { ...pdf, selectedText: 'different PDF contents' } })).rejects.toThrow('范围已改变');
  await expect(f.app.submit({ ...input, kind: 'quick' })).rejects.toThrow('PDF 或 Markdown 主聊天');
  const normal = await f.app.startNormal();
  await expect(f.app.submit({ ...input, unitId: normal.id })).rejects.toThrow('PDF 或 Markdown 主聊天');
  f.records.splice(0, 1); await f.app.refreshRecords();
  await expect(f.app.submit(input)).rejects.toThrow('范围已改变');
  expect(f.requests).toHaveLength(1); await f.app.dispose();
});

it('keeps the directory after a greeting and followup, then teaches the next explicitly chosen topic', async () => {
  const f = await setup(); await f.plan(); f.control.answer = '解释'; await f.teach();
  const before = f.progress()!;
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '你好' });
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '为什么要除以时间？' });
  expect(f.progress()!.completed).toEqual(before.completed);
  expect(f.records.slice(-2).every(record => !record.lesson)).toBe(true);
  await f.teach();
  expect(f.progress()!.completed).toHaveLength(2);
  expect(f.records.at(-1)?.lesson).toMatchObject({ kind: 'teach', topicKey: before.next!.key });
  await f.app.dispose();
});

it('retains the current PDF topic on selection followups and restores saved evidence only for explicit continuation', async () => {
  const f = await setup();
  try {
    await f.plan(); f.control.answer = '解释'; await f.teach();
    const selected = { ...pdf, pdf: undefined, selectedText: '选中的 PDF 原文', sourcePages: [1] };
    await f.app.submit({ unitId: f.unit.id, kind: 'main', context: selected, question: '为什么成立？' });
    expect(f.requests.at(-1)!.prompt).toContain('当前讲解主题：平均速度');
    expect(f.records.at(-1)?.context).toEqual(selected);
    expect(f.progress()!.completed).toHaveLength(1);
    await f.app.submit({ unitId: f.unit.id, kind: 'main', context: selected, question: '继续下一节' });
    expect(f.records.at(-1)?.context).toEqual(pdf);
    expect(f.records.at(-1)?.lesson).toMatchObject({ kind: 'teach', planId: f.progress()!.plan.id });
    expect(f.progress()!.completed).toHaveLength(2);
  } finally { await f.app.dispose(); }
});

it('teaching overrides direct answering and still includes the topic source', async () => {
  const f = await setup(); await f.plan();
  f.control.answer = '平均速度是总路程与总时间的比值。';
  const lesson = f.progress()!;
  await f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '开始讲解', answerPolicy: 'direct',
    lesson: { kind: 'teach', planId: lesson.plan.id, topicKey: lesson.next!.key } });
  expect(f.records.at(-1)).toMatchObject({ state: 'complete', evidenceMode: 'source', lesson: { kind: 'teach' } });
  expect(f.requests.at(-1)?.prompt).toContain('第1页：平均速度');
  expect(f.requests.at(-1)?.prompt).not.toContain('本轮不读取或检索');
  expect(f.progress()!.completed).toHaveLength(1);
});


async function teachBatch(f: Awaited<ReturnType<typeof setup>>, keys = f.progress()!.topics.map(topic => topic.key)) {
  return f.app.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '合并讲解',
    lesson: { kind: 'teach', planId: f.progress()!.plan.id, topicKey: keys[0]!, topicKeys: keys } });
}

it('saves one combined answer and restores both completed topics and followup scope', async () => {
  const f = await setup(); await f.plan(); f.control.answer = '合并讲解两个速度概念。';
  await teachBatch(f);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.prompt).toContain('合并为一次连贯讲解');
  expect(f.requests[1]!.prompt).toContain('理解平均速度');
  expect(f.requests[1]!.prompt).toContain('理解某时刻的速度');
  expect(f.records).toHaveLength(2);
  expect(f.progress()!.completed).toHaveLength(2);
  await f.app.dispose();
  const restored = f.create(); await restored.initialize();
  expect(f.progress(restored)!.completed).toHaveLength(2);
  await restored.submit({ unitId: f.unit.id, kind: 'main', context: pdf, question: '举个例子' });
  expect(f.requests.at(-1)!.prompt).toContain('当前讲解主题：平均速度、瞬时速度');
  expect(f.records.at(-1)!.lesson).toBeUndefined();
  f.records.splice(1, 1); await restored.refreshRecords();
  expect(f.progress(restored)!.completed).toEqual([]);
  await restored.dispose();
});

it.each(['cancel', 'error', 'unsaved', 'empty'] as const)('does not advance any batched topic on %s', async outcome => {
  const f = await setup(); await f.plan(); f.control.answer = outcome === 'empty' ? '' : '部分讲解';
  f.control.hold = outcome === 'cancel'; f.control.failCreate = outcome === 'unsaved'; f.control.failRun = outcome === 'error';
  const running = teachBatch(f);
  if (outcome === 'cancel') {
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    f.app.cancel(f.app.snapshot().running[0]!.requestId);
  }
  await running;
  expect(f.progress()!.completed).toEqual([]);
  await f.app.dispose();
});

it('rejects empty, duplicate or stale batch selections before dispatch', async () => {
  const f = await setup(); await f.plan();
  const key = f.progress()!.topics[0]!.key;
  for (const keys of [[], [key, key], [key, 'removed']]) await expect(teachBatch(f, keys)).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  await f.app.dispose();
});
