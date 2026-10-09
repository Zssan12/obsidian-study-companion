// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import type { StudyRecord } from '../../src/core/contracts';
import { parseNotebookEntries } from '../../src/application/SourceNotebook';
import { buildAnswerAppend, openAppendNote, openAppendRecords } from '../../src/ui/append-note-modal';

const host = vi.hoisted(() => ({ picker: undefined as unknown, modal: undefined as unknown, notice: vi.fn() }));
vi.mock('obsidian', () => {
  class Modal {
    contentEl = document.implementation.createHTMLDocument().createElement('div');
    constructor(public app: App) { host.modal = this; }
    open(): void { (this as unknown as { onOpen(): void }).onOpen(); }
    close(): void { (this as unknown as { onClose(): void }).onClose(); }
  }
  class FuzzySuggestModal {
    constructor(public app: App) { host.picker = this; }
    setPlaceholder(): void { /* host only */ }
    open(): void { /* host only */ }
  }
  return { Modal, FuzzySuggestModal, Notice: class { constructor(message: string) { host.notice(message); } } };
});

const record: StudyRecord = {
  id: 'record', unitId: 'unit', conversationId: 'main:unit', kind: 'main',
  createdAt: '2026-01-01T00:00:00Z', status: 'unresolved', state: 'complete',
  context: { sourcePath: 'notes/source.md', sourceName: 'Source', selectedText: '', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } },
  question: 'Why $x$?', answer: '$$\\frac{x}{y}$$\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```html\n<img src=x>\n```',
};
type Picker = { getItems(): TFile[]; onChooseItem(file: TFile): void };
type Preview = { contentEl: HTMLElement; close(): void };
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function setup() {
  const file = { path: 'notes/destination.md', extension: 'md' } as TFile;
  const structured = { path: 'records/answer.md', extension: 'md' } as TFile;
  let current = 'original';
  const process = vi.fn(async (_file: TFile, transform: (text: string) => string) => { current = transform(current); return current; });
  const app = {
    vault: { getMarkdownFiles: () => [file, structured], getAbstractFileByPath: vi.fn(() => file), process },
    metadataCache: { getFileCache: (candidate: TFile) => candidate === structured ? { frontmatter: { studyCompanionVersion: 1 } } : null },
  } as unknown as App;
  openAppendNote(app, record);
  const picker = host.picker as Picker;
  picker.onChooseItem(file);
  const modal = host.modal as Preview;
  const button = modal.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!;
  return { file, app, picker, modal, button, process, read: () => current, set: (text: string) => { current = text; } };
}

describe('append to an existing note', () => {
  it('merges a selected batch only after validation and confirmation', async () => {
    const view = setup();
    const second = { ...record, id: 'second', question: 'Second question' };
    const validate = vi.fn(async () => {});
    openAppendRecords(view.app, [record, second], validate);
    (host.picker as Picker).onChooseItem(view.file);
    const modal = host.modal as Preview;
    expect(modal.contentEl.querySelector('textarea')?.value).toContain('Second question');
    expect(view.process).not.toHaveBeenCalled();
    modal.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!.click();
    await vi.waitFor(() => expect(view.process).toHaveBeenCalledOnce());
    expect(validate).toHaveBeenCalledOnce();
    expect(parseNotebookEntries(view.read()).map(entry => entry.recordId)).toEqual(['record', 'second']);
    openAppendRecords(view.app, [record, second], async () => { throw new Error('收藏已改变'); });
    (host.picker as Picker).onChooseItem(view.file);
    const stale = host.modal as Preview; stale.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!.click();
    await vi.waitFor(() => expect(stale.contentEl.textContent).toContain('收藏已改变'));
    expect(view.process).toHaveBeenCalledOnce();
  });
  beforeEach(() => host.notice.mockReset());

  it('previews exact Markdown with source links and only writes after confirmation, preserving latest edits', async () => {
    const view = setup();
    expect(view.picker.getItems()).toEqual([view.file]);
    const preview = view.modal.contentEl.querySelector('textarea')!;
    expect(preview.value).toBe(buildAnswerAppend(record));
    expect(preview.readOnly).toBe(true);
    expect(preview.ownerDocument).toBe(view.modal.contentEl.ownerDocument);
    expect(preview.value).toContain(record.answer);
    expect(preview.value).toContain('[Source](</notes/source.md>)');
    expect(view.process).not.toHaveBeenCalled();
    view.set('edited after opening');
    view.button.click();
    await flush();
    expect(view.read()).toMatch(/^edited after opening/);
    expect(parseNotebookEntries(view.read())).toEqual([{ recordId: record.id, kind: 'raw', markdown: preview.value }]);
    expect(view.process).toHaveBeenCalledTimes(1);
  });

  it('cancel never writes', () => {
    const view = setup();
    view.modal.close();
    view.button.click();
    expect(view.process).not.toHaveBeenCalled();
  });

  it('disables duplicate confirmation and blocks close until an in-flight write completes', async () => {
    const view = setup();
    let release!: () => void;
    view.process.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return ''; });
    view.button.click();
    view.button.dispatchEvent(new Event('click'));
    view.modal.close();
    expect(view.modal.contentEl.querySelector('textarea')).not.toBeNull();
    expect(view.process).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(view.modal.contentEl.childElementCount).toBe(0);
    view.button.dispatchEvent(new Event('click'));
    expect(view.process).toHaveBeenCalledTimes(1);
  });

  it('shows a failed write and permits an explicit retry', async () => {
    const view = setup();
    view.process.mockRejectedValueOnce(new Error('Disk unavailable'));
    view.button.click();
    await flush();
    expect(view.modal.contentEl.textContent).toContain('Disk unavailable');
    expect(view.button.disabled).toBe(false);
    expect(view.read()).toBe('original');
    view.button.click();
    await flush();
    expect(view.read()).toMatch(/^original/);
    expect(parseNotebookEntries(view.read())[0]?.markdown).toBe(buildAnswerAppend(record));
    expect(view.process).toHaveBeenCalledTimes(2);
  });

  it('rejects structured records at the atomic write boundary even with a stale metadata cache', async () => {
    const view = setup();
    const content = '---\nstudyCompanionVersion: 1\n---\nrecord';
    view.set(content);
    view.button.click();
    await flush();
    expect(view.read()).toBe(content);
    expect(view.modal.contentEl.textContent).toContain('结构化回答记录');
  });

  it('does not recreate a deleted target or write a replacement at the same path', async () => {
    const view = setup();
    vi.mocked(view.app.vault.getAbstractFileByPath).mockReturnValue(null);
    view.button.click();
    await flush();
    expect(view.process).not.toHaveBeenCalled();
    expect(view.modal.contentEl.textContent).toContain('删除或替换');
  });

  it('includes attachment sources once and safely escapes link paths and labels', () => {
    const append = buildAnswerAppend({ ...record, attachments: [record.context, { ...record.context, sourcePath: 'notes/a#b].md', sourceName: '[Other]' }] });
    expect(append.match(/notes\/source.md/g)).toHaveLength(1);
    expect(append).toContain('[\\[Other\\]](</notes/a%23b%5D.md>)');
    expect(buildAnswerAppend({ ...record, context: { ...record.context, sourcePath: '' } })).not.toContain('### 来源');
  });
});


it('deduplicates a later save while preserving edits to the first saved answer', async () => {
  const view = setup(); view.button.click(); await flush();
  const edited = view.read().replace('Why $x$?', 'My edited question'); view.set(edited);
  openAppendNote(view.app, record);
  (host.picker as Picker).onChooseItem(view.file);
  (host.modal as Preview).contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!.click(); await flush();
  expect(view.read()).toBe(edited);
  expect(parseNotebookEntries(view.read())).toHaveLength(1);
});
