// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, TFile } from 'obsidian';
import { pickPdf, type PdfDocument } from '../../src/ui/pdf-picker';
import { MAX_PDF_TEXT } from '../../src/core/pdf';

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

type Picker = { getItems(): TFile[]; getItemText(file: TFile): string; onChooseItem(file: TFile): void; onClose(): void };
type Preview = { contentEl: HTMLElement; close(): void };
const file = { path: '资料/a #b[1].PDF', basename: 'a #b[1]', extension: 'PDF' } as TFile;
const note = { path: 'note.md', basename: 'note', extension: 'md' } as TFile;
const app = { vault: { getFiles: () => [note, file] } } as unknown as App;
const flush = async (): Promise<void> => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function reader(pageCount = 5) {
  return {
    pageCount,
    readPages: vi.fn(async (pages: number[]) => ({ pages: pages.map(page => ({ page, text: `页面内容 ${page}` })), emptyPages: [] as number[] })),
    close: vi.fn(async () => {}),
  } satisfies PdfDocument;
}
function controls() {
  const modal = host.modal as Preview;
  const button = (text: string) => Array.from(modal.contentEl.querySelectorAll('button')).find(item => item.textContent === text)!;
  const input = modal.contentEl.querySelector('input')!;
  const range = (value: string) => { input.value = value; input.dispatchEvent(new Event('input')); };
  return {
    modal, input, range, retry: button('重试'), use: button('使用所选页面'), cancel: button('取消'),
    status: modal.contentEl.querySelector('[role="status"]')!,
    details: modal.contentEl.querySelector('details')!, preview: modal.contentEl.querySelector('textarea')!,
  };
}
async function setup(document = reader()) {
  const openDocument = vi.fn(async () => document);
  const result = pickPdf(app, openDocument, file);
  await flush();
  return { ...controls(), document, openDocument, result };
}

describe('PDF source picker', () => {
  it('automatically imports all 300 indexed pages with progress and stores a reference rather than the full text', async () => {
    const document = Object.assign(reader(300), { sha256: 'a'.repeat(64), readIndexed: vi.fn(async (pages: number[], _signal: AbortSignal, progress: (done: number) => void) => {
      progress(150); progress(pages.length);
      return { emptyPages: [299], preview: '本地缓存原文预览' };
    }) });
    const view = await setup(document);
    expect(document.readIndexed).toHaveBeenCalledWith(Array.from({ length: 300 }, (_, i) => i + 1), expect.any(AbortSignal), expect.any(Function));
    expect(document.readPages).not.toHaveBeenCalled();
    expect(view.use.disabled).toBe(false); expect(view.status.textContent).toContain('原文已逐页缓存');
    view.use.click(); const result = await view.result;
    expect(result?.pdf?.indexed).toBe(true); expect(result?.pdf?.pages).toHaveLength(300);
    expect(result?.selectedText.length).toBeLessThan(200); expect(result?.pdf?.emptyPages).toEqual([299]);
  });

  it('aborts a long import on close without accepting a late completion', async () => {
    const work = deferred<{ emptyPages: number[]; preview: string }>(); let signal!: AbortSignal;
    const document = Object.assign(reader(300), { sha256: 'a'.repeat(64), readIndexed: async (_pages: number[], received: AbortSignal) => { signal = received; return work.promise; } });
    const view = await setup(document); view.cancel.click();
    expect(signal.aborted).toBe(true); expect(await view.result).toBeNull();
    work.resolve({ emptyPages: [], preview: 'late' }); await flush();
    expect(document.close).toHaveBeenCalledOnce();
  });
  beforeEach(() => { vi.useFakeTimers(); host.picker = undefined; host.modal = undefined; host.notice.mockReset(); });
  afterEach(() => vi.useRealTimers());

  it('accepts image-only evidence only with explicit visual support and preserves the fingerprint', async () => {
    const document = Object.assign(reader(1), { allowImages: true, sha256: 'a'.repeat(64) });
    document.readPages.mockResolvedValue({ pages: [{ page: 1, text: '' }], emptyPages: [1] });
    const view = await setup(document);
    expect(view.use.disabled).toBe(false);
    expect(view.status.textContent).toContain('查看页面图片');
    view.use.click();
    expect((await view.result)?.pdf).toEqual({ pages: [1], emptyPages: [1], pageCount: 1, sha256: 'a'.repeat(64) });
  });

  it('lists only PDFs, opens the chosen file, and cancels the file chooser without opening a document', async () => {
    const openDocument = vi.fn(async () => reader());
    const cancelled = pickPdf(app, openDocument);
    const picker = host.picker as Picker;
    expect(picker.getItems()).toEqual([file]);
    expect(picker.getItemText(file)).toBe(file.path);
    picker.onClose();
    expect(await cancelled).toBeNull();
    expect(openDocument).not.toHaveBeenCalled();
    const selected = pickPdf(app, openDocument);
    const secondPicker = host.picker as Picker;
    // Obsidian can close the suggestion modal before delivering onChooseItem.
    secondPicker.onClose();
    secondPicker.onChooseItem(file);
    await flush();
    expect(openDocument).toHaveBeenCalledWith(file.path);
    controls().cancel.click();
    expect(await selected).toBeNull();
  });

  it('automatically reads a short PDF and confirms exact, ordered evidence with metadata', async () => {
    const document = reader();
    document.readPages.mockResolvedValueOnce({
      pages: [{ page: 5, text: '最后一页\n原样内容' }, { page: 4, text: '第四页' }, { page: 3, text: '第三页' }, { page: 2, text: '' }, { page: 1, text: '第一页' }],
      emptyPages: [2],
    });
    const view = await setup(document);
    expect(host.picker).toBeUndefined();
    expect(view.modal.contentEl.textContent).toContain('共 5 页');
    expect(view.modal.contentEl.textContent).toContain('图表、公式和多栏内容可能不完整');
    expect(document.readPages).toHaveBeenCalledWith([1, 2, 3, 4, 5]);
    expect(view.use.disabled).toBe(false);
    expect(view.preview.readOnly).toBe(true);
    expect(view.preview.ownerDocument).toBe(view.modal.contentEl.ownerDocument);
    expect(view.details.open).toBe(false);
    expect(view.details.hidden).toBe(false);
    expect(view.preview.value).toContain('[第 1 页](</%E8%B5%84%E6%96%99/a%20%23b%5B1%5D.PDF#page=1>)\n\n第一页');
    expect(view.preview.value).toContain('最后一页\n原样内容');
    expect(view.preview.value.indexOf('第 1 页')).toBeLessThan(view.preview.value.indexOf('第 5 页'));
    expect(view.status.textContent).toContain('已就绪 · 5 页');
    expect(view.status.textContent).toContain('第 2 页无文本');
    expect(view.status.textContent).toContain('OCR');
    expect(view.status.textContent).toContain(view.preview.value.length.toLocaleString());
    expect(document.close).not.toHaveBeenCalled();
    const text = view.preview.value;
    view.use.click();
    const context = await view.result;
    expect(context).toEqual({
      sourcePath: file.path, sourceName: file.basename, selectedText: text, before: '', after: '',
      from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 5, pages: [1, 2, 3, 4, 5], emptyPages: [2] },
    });
    expect(document.close).toHaveBeenCalledTimes(1);
    expect(view.modal.contentEl.childElementCount).toBe(0);
  });

  it.each(['', '0', '6', '3-1', '1,', '1.5', '1-2-3', 'word', '1e2', '9007199254740992'])('rejects invalid page input %j before another read', async input => {
    const view = await setup();
    view.document.readPages.mockClear();
    view.range(input);
    expect(view.use.disabled).toBe(true);
    expect(view.preview.value).toBe('');
    await vi.advanceTimersByTimeAsync(300);
    expect(view.document.readPages).not.toHaveBeenCalled();
    expect(view.status.textContent).toContain('可以重试');
    expect(view.use.disabled).toBe(true);
    expect(view.retry.hidden).toBe(false);
    view.cancel.click();
    await view.result;
  });

  it('does not read all of a long PDF and debounces a valid range', async () => {
    const view = await setup(reader(101));
    expect(view.input.value).toBe('');
    expect(view.status.textContent).toContain('超过 100 页');
    expect(view.document.readPages).not.toHaveBeenCalled();
    view.range('all');
    await vi.advanceTimersByTimeAsync(300);
    expect(view.status.textContent).toContain('最多提取 100 页');
    expect(view.document.readPages).not.toHaveBeenCalled();
    view.range('1-101');
    await vi.advanceTimersByTimeAsync(300);
    expect(view.document.readPages).not.toHaveBeenCalled();
    view.range('1-100');
    await vi.advanceTimersByTimeAsync(299);
    expect(view.document.readPages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(view.document.readPages).toHaveBeenCalledWith(Array.from({ length: 100 }, (_, index) => index + 1));
    view.cancel.click();
    await view.result;
    const all = await setup(reader(2));
    expect(all.input.value).toBe('1-2');
    expect(all.document.readPages).toHaveBeenCalledWith([1, 2]);
    all.cancel.click();
    await all.result;
  });

  it('counts markers and links toward the text limit and rejects overflow without truncating', async () => {
    const document = reader(1);
    const prefix = '### [第 1 页](</%E8%B5%84%E6%96%99/a%20%23b%5B1%5D.PDF#page=1>)\n\n';
    document.readPages.mockResolvedValueOnce({ pages: [{ page: 1, text: '字'.repeat(MAX_PDF_TEXT - prefix.length + 1) }], emptyPages: [] });
    const view = await setup(document);
    expect(view.status.textContent).toContain('含页码标记和来源链接超过');
    expect(view.preview.value).toBe('');
    expect(view.use.disabled).toBe(true);
    document.readPages.mockResolvedValueOnce({ pages: [{ page: 1, text: '字'.repeat(MAX_PDF_TEXT - prefix.length) }], emptyPages: [] });
    view.retry.click();
    await flush();
    expect(view.preview.value).toHaveLength(MAX_PDF_TEXT);
    view.use.click();
    expect((await view.result)?.selectedText).toHaveLength(MAX_PDF_TEXT);
  });

  it('rejects image-only pages with OCR guidance and lets the user retry', async () => {
    const document = reader(1);
    document.readPages.mockResolvedValueOnce({ pages: [{ page: 1, text: ' \n ' }], emptyPages: [1] });
    const view = await setup(document);
    expect(view.status.textContent).toContain('OCR');
    expect(view.use.disabled).toBe(true);
    expect(document.close).not.toHaveBeenCalled();
    view.retry.click();
    await flush();
    expect(view.use.disabled).toBe(false);
    view.use.click();
    await view.result;
  });

  it('keeps extraction failures open for an explicit retry and invalidates previews when page input changes', async () => {
    const document = reader();
    document.readPages.mockRejectedValueOnce(new Error('页面暂时不可读'));
    const view = await setup(document);
    expect(view.status.textContent).toContain('页面暂时不可读');
    expect(view.retry.hidden).toBe(false);
    view.retry.click();
    await flush();
    expect(view.use.disabled).toBe(false);
    view.range('2');
    expect(view.use.disabled).toBe(true);
    expect(view.preview.value).toBe('');
    view.use.dispatchEvent(new Event('click'));
    expect(document.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    view.use.click();
    expect((await view.result)?.pdf?.pages).toEqual([2]);
  });

  it('allows explicit retry after an opening failure', async () => {
    const document = reader();
    const openDocument = vi.fn<() => Promise<PdfDocument>>().mockRejectedValueOnce(new Error('PDF 暂时不可读')).mockResolvedValue(document);
    const result = pickPdf(app, openDocument, file);
    await flush();
    const view = controls();
    expect(view.status.textContent).toContain('打开失败');
    expect(view.retry.hidden).toBe(false);
    view.retry.click();
    await flush();
    expect(openDocument).toHaveBeenCalledTimes(2);
    expect(document.readPages).toHaveBeenCalledTimes(1);
    view.use.click();
    await result;
  });

  it('closes a document that finishes opening after cancellation without restoring the modal', async () => {
    const pending = deferred<PdfDocument>();
    const document = reader();
    const result = pickPdf(app, () => pending.promise, file);
    const view = controls();
    view.cancel.click();
    expect(await result).toBeNull();
    pending.resolve(document);
    await flush();
    expect(document.close).toHaveBeenCalledTimes(1);
    expect(document.readPages).not.toHaveBeenCalled();
    expect(view.modal.contentEl.childElementCount).toBe(0);
  });

  it('serializes reads and uses only the latest range after stale edits', async () => {
    const first = deferred<Awaited<ReturnType<PdfDocument['readPages']>>>();
    const document = reader(5);
    document.readPages.mockReturnValueOnce(first.promise);
    const view = await setup(document);
    expect(document.readPages).toHaveBeenCalledTimes(1);

    view.range('2');
    expect(view.use.disabled).toBe(true);
    expect(view.preview.value).toBe('');
    await vi.advanceTimersByTimeAsync(300);
    expect(document.readPages).toHaveBeenCalledTimes(1);
    view.range('3');
    await vi.advanceTimersByTimeAsync(300);
    expect(document.readPages).toHaveBeenCalledTimes(1);

    first.resolve({ pages: [1, 2, 3, 4, 5].map(page => ({ page, text: `旧内容 ${page}` })), emptyPages: [] });
    await flush();
    expect(document.readPages).toHaveBeenCalledTimes(2);
    expect(document.readPages).toHaveBeenLastCalledWith([3]);
    expect(view.status.textContent).toContain('已就绪 · 1 页');
    view.use.click();
    const context = await view.result;
    expect(context?.pdf).toEqual({ pageCount: 5, pages: [3], emptyPages: [] });
    expect(context?.selectedText).toContain('页面内容 3');
    expect(context?.selectedText).not.toContain('旧内容');
  });

  it('confirms with Enter only for a ready result and never during IME composition', async () => {
    const view = await setup(reader(2));
    view.input.dispatchEvent(new CompositionEvent('compositionstart'));
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(view.document.close).not.toHaveBeenCalled();
    view.input.dispatchEvent(new CompositionEvent('compositionend'));

    view.range('2');
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(view.document.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect((await view.result)?.pdf?.pages).toEqual([2]);
  });

  it('cancels a pending debounced range without starting a read', async () => {
    const view = await setup(reader(101));
    view.range('1-20');
    view.cancel.click();
    expect(await view.result).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(view.document.readPages).not.toHaveBeenCalled();
    expect(view.document.close).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('ignores a late extraction %s after cancellation and prevents duplicate operations', async outcome => {
    const pending = deferred<Awaited<ReturnType<PdfDocument['readPages']>>>();
    const document = reader(1);
    document.readPages.mockReturnValueOnce(pending.promise);
    const view = await setup(document);
    expect(document.readPages).toHaveBeenCalledTimes(1);
    view.cancel.click();
    expect(await view.result).toBeNull();
    expect(document.close).not.toHaveBeenCalled();
    if (outcome === 'resolve') pending.resolve({ pages: [{ page: 1, text: '迟到内容' }], emptyPages: [] });
    else pending.reject(new Error('迟到错误'));
    await flush();
    expect(document.close).toHaveBeenCalledTimes(1);
    expect(view.modal.contentEl.childElementCount).toBe(0);
    view.use.dispatchEvent(new Event('click'));
    view.modal.close();
    expect(document.close).toHaveBeenCalledTimes(1);
  });

  it('awaits document cleanup before returning confirmed evidence', async () => {
    const document = reader(1);
    const cleanup = deferred<void>();
    document.close.mockReturnValueOnce(cleanup.promise);
    const view = await setup(document);
    const delivered = vi.fn();
    void view.result.then(delivered);
    view.use.click();
    await flush();
    expect(delivered).not.toHaveBeenCalled();
    cleanup.resolve();
    expect((await view.result)?.pdf?.pages).toEqual([1]);
    expect(document.close).toHaveBeenCalledTimes(1);
  });
  it('can change the current PDF by clicking its filename without accepting old evidence', async () => {
    const view = await setup(reader(1));
    view.modal.contentEl.querySelector<HTMLButtonElement>('.study-companion-pdf-file')!.click();
    await flush();
    const picker = host.picker as Picker;
    expect(picker.getItems()).toEqual([file]);
    picker.onClose();
    expect(await view.result).toBeNull();
  });

});
