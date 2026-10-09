import { expect, it, vi } from 'vitest';
import { compactSelection, emptySourceContext, resolveComposerContext } from '../../src/application/composer-context';
import type { SourceContext, StudySnapshot, StudyRecord } from '../../src/core/contracts';
const source = (path: string): SourceContext => ({ sourcePath: path, sourceName: path, selectedText: '第一段测试内容结尾', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 9 } });
const snapshot: StudySnapshot = { mode: 'study', units: [{ id: 'a', sourcePath: 'A.md', createdAt: 'now' }], activeUnitId: 'a', records: [], running: [], errors: [], pinned: false };
it('previews the current unbound file rather than the previously active unit', () => {
  expect(resolveComposerContext(snapshot, () => source('B.md'), [])?.sourcePath).toBe('B.md');
});
it('keeps a locked source and does not silently send the other editor selection', () => {
  const record = { unitId: 'a', kind: 'main', createdAt: 'now', context: source('A.md') } as StudyRecord;
  const resolved = resolveComposerContext({ ...snapshot, pinned: true, records: [record] }, () => source('B.md'), []);
  expect(resolved).toEqual(source('A.md'));
  expect(resolved).not.toBe(record.context);
  expect(() => resolveComposerContext({ ...snapshot, pinned: true }, () => source('B.md'), [])).toThrow('缺少可用引用');
});
it('previews explicit PDF attachment and rejects switching a locked source', () => {
  const pdf = { ...source('C.pdf'), pdf: { pageCount: 3, pages: [2], emptyPages: [] } };
  expect(resolveComposerContext(snapshot, () => source('A.md'), [pdf])).toEqual(pdf);
  expect(() => resolveComposerContext({ ...snapshot, pinned: true }, () => source('A.md'), [pdf])).toThrow('请先打开这份 PDF');
});
it('normal chat includes an explicit selection, never surrounding paragraphs or implicit PDF history', () => {
  const read = vi.fn(() => ({ ...source('B.md'), before: 'not selected', after: 'not selected' }));
  expect(resolveComposerContext({ ...snapshot, mode: 'normal' }, read, [source('C.md')])).toEqual(source('B.md'));
  expect(resolveComposerContext({ ...snapshot, mode: 'normal' }, () => emptySourceContext('B.md'), [])).toEqual(emptySourceContext());
  const pdf = { ...source('C.pdf'), pdf: { pageCount: 3, pages: [2], emptyPages: [] } };
  expect(resolveComposerContext({ ...snapshot, mode: 'normal' }, () => pdf, [])).toEqual(emptySourceContext());
});
it('shows exactly two characters at either end without splitting emoji', () => {
  expect(compactSelection('第一段测试内容结尾')).toBe('第一…结尾');
  expect(compactSelection('😀😃中间内容😄😁')).toBe('😀😃…😄😁');
  expect(compactSelection('短文')).toBe('短文');
});
