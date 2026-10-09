import { expect, it, vi } from 'vitest';
import type { BackendRequest, SourceContext, StudyBackend } from '../../src/core/contracts';
import { markdownLessonContext } from '../../src/core/markdown';
import { markdownOutlineBatches, planMarkdown } from '../../src/application/markdown-lesson';
import { parseLessonOutline, sameLessonEvidence } from '../../src/application/lesson';
import { validateContext } from '../../src/application/prompts';
import { estimateTokens } from '../../src/application/context-budget';

const source: SourceContext = { sourcePath: 'Note.md', sourceName: 'Note', selectedText: '选区', before: '之前', after: '之后', from: { line: 3, ch: 1 }, to: { line: 3, ch: 3 } };
const outline = '## 1. 概念\n目标：理解概念。';

it('captures whole notes and selections without surrounding text, preserving their distinct scope', () => {
  const selection = markdownLessonContext(source, source.selectedText, 'selection');
  const document = markdownLessonContext(source, '# 标题\n原文', 'document');
  expect(selection).toMatchObject({ before: '', after: '', from: source.from, to: source.to, markdown: { scope: 'selection' } });
  expect(document).toMatchObject({ from: { line: 0, ch: 0 }, to: { line: 1, ch: 2 }, markdown: { scope: 'document' } });
  expect(sameLessonEvidence(document, { ...document, sourcePath: 'Renamed.md' })).toBe(true);
  expect(sameLessonEvidence(document, { ...document, selectedText: 'changed' })).toBe(false);
  expect(sameLessonEvidence(selection, { ...selection, markdown: { scope: 'document' } })).toBe(false);
  expect(source.before).toBe('之前');
});

it('rejects empty, excessive and non-note input without silently truncating or relaxing ordinary selection limits', () => {
  expect(() => markdownLessonContext(source, ' ', 'document')).toThrow('为空');
  expect(() => markdownLessonContext(source, 'x'.repeat(60001), 'document')).toThrow('60000');
  expect(() => markdownLessonContext({ ...source, answerRecordId: 'answer' }, 'text', 'selection')).toThrow('普通 Markdown');
  expect(() => markdownLessonContext({ ...source, sourcePath: 'Course.pdf' }, 'text', 'document')).toThrow('普通 Markdown');
  expect(() => validateContext({ ...source, selectedText: 'x'.repeat(12001) })).toThrow('12000');
  expect(() => validateContext(markdownLessonContext(source, 'x'.repeat(60000), 'document'))).not.toThrow();
});

it('accepts headingless notes and requires objectives without fabricated page numbers', () => {
  const context = markdownLessonContext(source, '没有标题的一段内容。', 'document');
  expect(parseLessonOutline(outline, context)[0]).toMatchObject({ title: '概念', pages: [], objective: '理解概念。' });
  expect(() => parseLessonOutline('## 1. 概念', context)).toThrow();
  expect(() => parseLessonOutline(outline + '\n页码：1', context)).toThrow('不使用 PDF 页码');
});

it('batches all mixed text including the tail, with bounded independent model calls', async () => {
  const text = ('# 标题\n正文😀测试。\n').repeat(3500) + '尾部唯一内容';
  const batches = markdownOutlineBatches(text);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.join('')).toBe(text);
  expect(batches.every(batch => estimateTokens(batch) <= 30000)).toBe(true);
  const requests: BackendRequest[] = [];
  const backend: StudyBackend = { async *run(request) {
    requests.push(request); yield { type: 'text', text: '## 1. 批次' + requests.length + '\n目标：理解本批内容。' }; yield { type: 'done' };
  }, dispose() {} };
  const context = markdownLessonContext(source, text, 'document');
  const answer = await planMarkdown(context, backend, { requestId: 'plan', prompt: '', sessionId: 'main', retainSession: true, signal: new AbortController().signal }, vi.fn());
  expect(requests).toHaveLength(batches.length);
  expect(requests.every(request => !request.sessionId && !request.retainSession && estimateTokens(request.prompt) < 48000)).toBe(true);
  expect(requests.at(-1)!.prompt).toContain('尾部唯一内容');
  expect(parseLessonOutline(answer, context)).toHaveLength(batches.length);
});

it('stops between batches on cancellation, and preserves malformed generated content without retries', async () => {
  const abort = new AbortController(); let calls = 0;
  const backend: StudyBackend = { async *run() { calls++; abort.abort(); yield { type: 'done' }; }, dispose() {} };
  const context = markdownLessonContext(source, '字'.repeat(40000), 'document');
  await expect(planMarkdown(context, backend, { requestId: 'cancel', prompt: '', signal: abort.signal }, vi.fn())).rejects.toThrow('取消');
  expect(calls).toBe(1);
  const invalid: StudyBackend = { async *run() { calls++; yield { type: 'text', text: '格式错误但保留' }; yield { type: 'done' }; }, dispose() {} };
  await expect(planMarkdown(context, invalid, { requestId: 'bad', prompt: '', signal: new AbortController().signal }, vi.fn())).rejects.toMatchObject({ answer: '格式错误但保留' });
  expect(calls).toBe(2);
});
