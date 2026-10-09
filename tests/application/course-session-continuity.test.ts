import { describe, expect, it } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import { deriveLesson } from '../../src/application/lesson';
import type { BackendEvent, BackendRequest, SourceContext, StudyRecord, StudyRepository, StudyState } from '../../src/core/contracts';
import type { LongPdfServices } from '../../src/application/long-pdf';

const outline = '## 1. 平均速度\n页码：1\n目标：理解平均速度。\n\n## 2. 瞬时速度\n页码：2\n目标：理解瞬时速度。';
const answers = [outline, 'ANSWER_A_UNIQUE 平均速度的解释。', 'ANSWER_B_UNIQUE 瞬时速度的解释。', 'FOLLOWUP_UNIQUE 举例。'];

async function runCourse(indexed: boolean, batch = false) {
  let state: StudyState = { version: 1, units: [] };
  const records: StudyRecord[] = [];
  const requests: BackendRequest[] = [];
  const returnedSessions: string[] = [];
  const repository: StudyRepository = {
    async loadState() { return structuredClone(state); },
    async saveState(next) { state = structuredClone(next); },
    async listRecords() { return structuredClone(records); },
    async createRecord(record) { records.push(structuredClone(record)); },
    async updateStatus() {},
  };
  const backend = {
    async *run(request: BackendRequest): AsyncIterable<BackendEvent> {
      requests.push(request);
      const sessionId = request.sessionId ?? `fake-codex-thread-${requests.length}`;
      returnedSessions.push(sessionId);
      yield { type: 'session', sessionId };
      yield { type: 'text', text: requests.length === 1 && batch ? `${outline}\n\n## 3. 加速度\n页码：3\n目标：理解加速度。` : answers[requests.length - 1]! };
      yield { type: 'done' };
    },
    dispose() {},
  };
  const services: LongPdfServices = {
    configuration: () => 'fake-codex', semanticPlanning: false,
    library: { async read(_sha, pages) { return pages.map(page => ({ page, text: page === 1 ? '平均速度原文。' : page === 2 ? '瞬时速度原文。' : 'UNSELECTED_PAGE_THREE 原文。' })); } },
  };
  const context: SourceContext = {
    sourcePath: 'Course.pdf', sourceName: 'Course', selectedText: indexed ? '已导入 2 页' : '平均速度原文。瞬时速度原文。',
    before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 },
    pdf: { pageCount: batch ? 3 : 2, pages: batch ? [1, 2, 3] : [1, 2], emptyPages: [], ...(indexed ? { indexed: true, sha256: 'a'.repeat(64) } : {}) },
  };
  let id = 0;
  const app = new StudyController(backend, repository, () => `id-${++id}`, () => new Date(1_800_000_000_000 + id * 1000).toISOString(), () => 'codex', undefined, services);
  await app.initialize();
  const unit = await app.startStudy(context);
  const submit = (question: string) => ({ unitId: unit.id, kind: 'main' as const, context, question });
  await app.submit({ ...submit('生成目录'), lesson: { kind: 'plan' } });
  for (const question of batch ? ['合并讲解'] : ['讲解平均速度', '讲解瞬时速度']) {
    const lesson = deriveLesson(app.snapshot().units[0]!, records, context)!;
    expect(lesson).not.toBeNull();
    await app.submit({ ...submit(question), lesson: { kind: 'teach', planId: lesson.plan.id, topicKey: lesson.next!.key, ...(batch ? { topicKeys: lesson.topics.slice(0, 2).map(topic => topic.key) } : {}) } });
  }
  await app.submit(submit('举个例子'));
  const snapshot = app.snapshot();
  await app.dispose();
  return { records, requests, returnedSessions, snapshot };
}

describe('course session continuity through the actual controller', () => {
  it('resumes one backend thread for legacy PDF plan, topic A, topic B and followup', async () => {
    const f = await runCourse(false);
    expect(f.records.map(record => record.state)).toEqual(['complete', 'complete', 'complete', 'complete']);
    expect(f.requests.map(request => request.sessionId)).toEqual([undefined, 'fake-codex-thread-1', 'fake-codex-thread-1', 'fake-codex-thread-1']);
    expect(new Set(f.returnedSessions).size).toBe(1);
    expect(f.requests[2]!.prompt).not.toContain('ANSWER_A_UNIQUE');
    expect(f.requests[3]!.prompt).not.toContain('ANSWER_B_UNIQUE');
    expect(f.requests[3]!.prompt).toContain('当前讲解主题：瞬时速度');
  });

  it('keeps topic A, topic B and followup in one private session without replaying answers', async () => {
    const f = await runCourse(true);
    expect(f.records.map(record => record.state)).toEqual(['complete', 'complete', 'complete', 'complete']);
    expect(f.requests).toHaveLength(4);
    expect(f.requests.map(request => request.sessionId)).toEqual([undefined, undefined, 'fake-codex-thread-2', 'fake-codex-thread-2']);
    expect(f.requests.slice(1).every(request => request.retainSession)).toBe(true);
    expect(new Set(f.returnedSessions).size).toBe(2);
    expect(new Set(f.records.map(record => record.conversationId)).size).toBe(1);
    expect(f.records.every(record => record.contextManaged)).toBe(true);
    expect(f.requests[1]!.prompt).toContain('理解平均速度');
    expect(f.requests[2]!.prompt).not.toContain('ANSWER_A_UNIQUE');
    expect(f.requests[3]!.prompt).not.toContain('ANSWER_A_UNIQUE');
    expect(f.requests[3]!.prompt).not.toContain('ANSWER_B_UNIQUE');
    expect(f.requests[3]!.prompt).toContain('当前讲解主题：瞬时速度');
    expect(f.requests[3]!.prompt.endsWith(JSON.stringify({ currentQuestion: '举个例子' }))).toBe(true);
    expect(f.snapshot.units[0]!.mainSessionId).toBe('fake-codex-thread-2');
  });
});

it('combines indexed PDF evidence and continues the same private thread after a batch', async () => {
  const f = await runCourse(true, true);
  expect(f.requests).toHaveLength(3);
  expect(f.records.map(record => record.state)).toEqual(['complete', 'complete', 'complete']);
  expect(f.requests[1]!.prompt).toContain('平均速度原文。');
  expect(f.requests[1]!.prompt).toContain('瞬时速度原文。');
  expect(f.requests[1]!.prompt).toContain('合并为一次连贯讲解');
  expect(f.requests[1]!.prompt).not.toContain('UNSELECTED_PAGE_THREE');
  expect(f.requests[2]!.sessionId).toBe(f.returnedSessions[1]);
  expect(f.requests[2]!.prompt).not.toContain('ANSWER_A_UNIQUE');
  expect(f.requests[2]!.prompt).toContain('当前讲解主题：平均速度、瞬时速度');
  expect(deriveLesson(f.snapshot.units[0]!, f.records)!.completed).toHaveLength(2);
});
