import { expect, it, vi } from 'vitest';
import type { BackendRequest, StudyBackend, StudyRecord } from '../../src/core/contracts';
import type { ContextCache } from '../../src/core/context';
import { managedHistory } from '../../src/application/conversation-context';
import { estimateTokens } from '../../src/application/context-budget';

function record(id: number, size = 100): StudyRecord {
  return { id: `record-${id}`, unitId: 'unit', kind: 'main', conversationId: 'main:unit',
    context: { sourcePath: 'Course.pdf', sourceName: 'Course', selectedText: '原文', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } },
    question: `问题${id}`, answer: `ANSWER_${id} ${'内容'.repeat(size)}`, createdAt: `2026-01-${String(id + 1).padStart(2, '0')}`, state: 'complete', status: 'unresolved' };
}
function fixture() {
  const requests: BackendRequest[] = [];
  const backend: StudyBackend = { async *run(request) { requests.push(request); yield { type: 'text', text: '历史摘要：保留学习目标。' }; yield { type: 'done' }; }, dispose() {} };
  const values = new Map<string, string>();
  const cache: ContextCache = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
  const progress = vi.fn();
  const run = (records: StudyRecord[], budget = 40000) => managedHistory(records, '问题', backend,
    { requestId: 'test', prompt: '', signal: new AbortController().signal }, cache, 'unit:main:epoch', progress, budget);
  return { requests, progress, run };
}

it('passes all fitting history verbatim without summary calls even beyond four turns or 12000 characters', async () => {
  const f = fixture(); const records = Array.from({ length: 9 }, (_, i) => record(i, 900));
  const original = structuredClone(records);
  const result = await f.run(records);
  expect(f.requests).toHaveLength(0); expect(f.progress).not.toHaveBeenCalled();
  for (const r of records) expect(result).toContain(r.answer);
  expect(estimateTokens(result)).toBeLessThanOrEqual(40000);
  expect(records).toEqual(original);
});

it('summarizes only overflow, reuses cached prefixes, and does not announce compression for cached results', async () => {
  const f = fixture(); const records = Array.from({ length: 10 }, (_, i) => record(i, 500));
  const result = await f.run(records, 9000);
  expect(f.requests.length).toBeGreaterThan(0);
  expect(result).toContain(records.at(-1)!.answer);
  expect(estimateTokens(result)).toBeLessThanOrEqual(9000);
  const count = f.requests.length; f.progress.mockClear();
  expect(await f.run(records, 9000)).toBe(result);
  expect(f.requests).toHaveLength(count); expect(f.progress).not.toHaveBeenCalled();
  await f.run([...records, record(10, 500)], 9000);
  expect(f.requests.length - count).toBeLessThan(count);
  expect(f.requests.length).toBeGreaterThan(count);
});

it('invalidates an edited or removed prefix and never uses failed or unsaved answers', async () => {
  const f = fixture(); const records = Array.from({ length: 6 }, (_, i) => record(i, 1000));
  await f.run(records, 8000); const count = f.requests.length;
  const edited = structuredClone(records); edited[0]!.answer = '已修改的历史'.repeat(500);
  await f.run(edited, 8000);
  expect(f.requests.length).toBeGreaterThan(count);
  expect(f.requests[count]!.prompt).toContain('已修改的历史');
  const empty = await f.run([{ ...record(0), state: 'error' }, { ...record(1), unsaved: true }]);
  expect(empty).not.toContain('ANSWER_');
  expect(await f.run([])).toBe('');
});

it('does not spend model calls on history when no context budget is available and respects cancellation', async () => {
  const f = fixture();
  const result = await f.run([record(1, 5000)], 0);
  expect(result).toBe(''); expect(f.requests).toHaveLength(0);
  const aborted = new AbortController(); aborted.abort();
  await expect(managedHistory([], '', {} as StudyBackend, { requestId: 'x', prompt: '', signal: aborted.signal }, undefined, '', () => {})).rejects.toThrow();
});
