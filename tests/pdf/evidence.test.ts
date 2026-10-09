import { describe, expect, it } from 'vitest';
import { buildPrompt, validateContext } from '../../src/application/prompts';
import { isPdfEvidence } from '../../src/core/pdf';
import { cloneSourceContext } from '../../src/ui/helpers';
import type { SourceContext } from '../../src/core/contracts';
const context: SourceContext = { sourcePath: 'Lesson.pdf', sourceName: 'Lesson', selectedText: 'Page 2 evidence', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 15 }, pdf: { pageCount: 20, pages: [2, 3], emptyPages: [3] } };
describe('PDF evidence', () => {
  it('retains explicit pages and warns about missing visual content in both modes', () => {
    for (const mode of ['study', 'normal'] as const) {
      const prompt = buildPrompt(context, 'Summarize', 'main', mode);
      expect(prompt).toContain('"pages":[2,3]');
      expect(prompt).toContain('"emptyPages":[3]');
      expect(prompt).toContain('不是印刷页码');
      expect(prompt).toContain('#page=N');
      expect(prompt).toContain('不能声称看过页面图片');
    }
    const clone = cloneSourceContext(context); clone.pdf!.pages[0] = 1;
    expect(context.pdf!.pages).toEqual([2, 3]);
  });
  it('allows bounded PDF text while retaining Markdown limits', () => {
    expect(() => validateContext({ ...context, selectedText: 'x'.repeat(60000) })).not.toThrow();
    expect(() => validateContext({ ...context, selectedText: 'x'.repeat(60001) })).toThrow('页码范围');
    expect(() => validateContext({ ...context, pdf: undefined, selectedText: 'x'.repeat(12001) })).toThrow('12000');
    expect(() => buildPrompt({ ...context, selectedText: 'x'.repeat(60000) }, 'Compare', 'main', 'study', [{ ...context, selectedText: 'y'.repeat(30000) }])).toThrow('合计过长');
  });
  it('rejects malformed page metadata instead of inventing valid pages', () => {
    for (const pages of [[], [0], [21], [2, 2], [3, 2], [1.5]]) expect(isPdfEvidence({ ...context.pdf, pages })).toBe(false);
    expect(isPdfEvidence({ ...context.pdf, emptyPages: [4] })).toBe(false);
    expect(() => validateContext({ ...context, pdf: { ...context.pdf!, pages: [0] } })).toThrow('页码信息');
  });
});
