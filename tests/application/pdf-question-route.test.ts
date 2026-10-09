import { describe, expect, it } from 'vitest';
import { resolvePdfQuestionRoute, previewMainPdfRoute } from '../../src/application/pdf-question-route';
import type { SourceContext, StudySnapshot } from '../../src/core/contracts';

const pdf: SourceContext = { sourcePath: 'scan.pdf', sourceName: 'scan', selectedText: 'page label', before: '', after: '',
  from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 2, pages: [1, 2], emptyPages: [1, 2], sha256: 'a'.repeat(64) } };
const base = { enabled: true, mode: 'study' as const, kind: 'main' as const, context: pdf };

describe('PDF preview and dispatch policy', () => {
  it('allows scans only when the actual request can see images', () => {
    expect(resolvePdfQuestionRoute(base)).toMatchObject({ mode: 'visual' });
    expect(resolvePdfQuestionRoute(base).blocked).toBeUndefined();
    for (const patch of [{ enabled: false }, { mode: 'normal' as const }, { hasLesson: true }, { question: '生成目录！' },
      { lesson: { kind: 'plan' as const } }, { attachments: [pdf] }]) {
      expect(resolvePdfQuestionRoute({ ...base, ...patch })).toMatchObject({ mode: 'text', blocked: expect.stringContaining('无法发送') });
    }
  });

  it('allows an independent Quick Ask alongside a main lesson', () => {
    expect(resolvePdfQuestionRoute({ ...base, kind: 'quick', hasLesson: true, question: '生成目录' }).mode).toBe('visual');
  });

  it('allows a page-scoped visual question during a course but preserves explicit lesson text preparation', () => {
    const input = { ...base, hasLesson: true, question: '概述第 1 页图表',
      context: { ...pdf, pdf: { ...pdf.pdf!, indexed: true as const, preparationScope: 'question' as const, pages: [1], emptyPages: [1] } } };
    expect(resolvePdfQuestionRoute(input).mode).toBe('visual');
    expect(resolvePdfQuestionRoute({ ...input, lesson: { kind: 'plan' } }).mode).toBe('text');
  });

  it('blocks scan-only PDF attachments even when other evidence has text', () => {
    const markdown = { ...pdf, pdf: undefined, sourcePath: 'note.md', selectedText: 'real text' };
    expect(resolvePdfQuestionRoute({ ...base, context: markdown, attachments: [pdf] }).blocked).toContain('scan');
  });

  it('discloses text fallback without blocking readable pages', () => {
    const mixed = { ...pdf, pdf: { ...pdf.pdf!, emptyPages: [2] } };
    expect(resolvePdfQuestionRoute({ ...base, context: mixed, enabled: false }).blocked).toBeUndefined();
    expect(resolvePdfQuestionRoute({ ...base, context: mixed, enabled: false })).toMatchObject({ mode: 'text',
      message: expect.stringContaining('无文字页面的内容不会提供给模型') });
    expect(resolvePdfQuestionRoute({ ...base, context: { ...mixed, pdf: { ...mixed.pdf, sha256: undefined } } }).blocked).toContain('重新选择');
  });

  it('uses the active lesson for preview and releases text fallback when that lesson is removed', () => {
    const readable = { ...pdf, pdf: { ...pdf.pdf!, emptyPages: [] } };
    const snapshot: StudySnapshot = { mode: 'study', pinned: false, activeUnitId: 'u', running: [], errors: [],
      units: [{ id: 'u', sourcePath: pdf.sourcePath, createdAt: 'now', lesson: { planId: 'plan', order: [], skipped: [] } }],
      records: [{ id: 'plan', unitId: 'u', conversationId: 'main:u', kind: 'main', context: readable, question: '目录',
        answer: '## 1. 概念\n页码：1\n目标：理解概念。', lesson: { kind: 'plan' }, state: 'complete', status: 'unresolved', createdAt: 'now' }] };
    expect(previewMainPdfRoute(snapshot, readable, [], true, '解释图表').message).toContain('目录讲解仅使用文字');
    expect(previewMainPdfRoute({ ...snapshot, records: [] }, readable, [], true, '解释图表').mode).toBe('visual');
  });

  it('previews PDF promotion in study mode and retains the attachment in normal mode', () => {
    const state: StudySnapshot = { units: [], records: [], running: [], errors: [], pinned: false };
    expect(previewMainPdfRoute(state, pdf, [pdf], true, '看图').mode).toBe('visual');
    expect(previewMainPdfRoute({ ...state, mode: 'normal' }, null, [pdf], true, '看图')).toMatchObject({ mode: 'text', blocked: expect.any(String) });
    expect(previewMainPdfRoute(state, pdf, [pdf, pdf], true, '看图').blocked).toBeDefined();
  });
});
