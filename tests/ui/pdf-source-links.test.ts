// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { StudyRecord, StudyUnit } from '../../src/core/contracts';
import { addPdfSourceLinks } from '../../src/ui/pdf-source-links';
it('opens the exact selected file page from persisted PDF evidence', () => {
  const openLinkText = vi.fn(async () => {});
  const app = { workspace: { openLinkText } } as unknown as App;
  const parent = document.createElement('div');
  const context = { sourcePath: 'notes/Lesson #1.pdf', sourceName: 'Lesson', selectedText: 'text', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 5, pages: [2, 4], emptyPages: [] } };
  const record = { context, attachments: [] } as unknown as StudyRecord;
  addPdfSourceLinks(parent, app, record);
  const links = parent.querySelectorAll('a');
  expect(links).toHaveLength(2);
  links[1]!.click();
  expect(openLinkText).toHaveBeenCalledWith('notes/Lesson #1.pdf#page=4&offset=0,,0', '', false);
});

it.each([
  { id: 'owner', mode: 'normal', sourcePath: '' },
  { id: 'other', mode: 'study', sourcePath: 'Unrelated.pdf' },
] as const)('keeps explicit PDF evidence independent of a $mode unit with ID $id', unit => {
  const openLinkText = vi.fn(async () => {});
  const parent = document.createElement('div');
  const context = { sourcePath: 'Captured.pdf', sourceName: 'Captured', selectedText: 'text', before: '', after: '',
    from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 5, pages: [3], emptyPages: [] } };
  const record: StudyRecord = { id: 'record', unitId: 'owner', conversationId: 'quick:saved', kind: 'quick',
    question: 'Question', answer: 'Answer', createdAt: '2026-01-01', status: 'unresolved', state: 'complete', context };
  addPdfSourceLinks(parent, { workspace: { openLinkText } } as unknown as App,
    record, { ...unit, createdAt: '2026-01-01' } as StudyUnit);
  parent.querySelector('a')!.click();
  expect(openLinkText).toHaveBeenCalledWith('Captured.pdf#page=3&offset=0,,0', '', false);
});
