import { FuzzySuggestModal, Modal, Notice, type App, type TFile } from 'obsidian';
import type { SourceContext } from '../core/contracts';
import { pdfPageText } from '../core/pdf-agent';
import { MAX_PDF_PAGES, MAX_PDF_TEXT } from '../core/pdf';

const RANGE_DEBOUNCE_MS = 300;

/** Injected by the composition root; the UI does not own a concrete PDF reader. */
export interface PdfDocument {
  readIndexed?(pages: number[], signal: AbortSignal, progress: (done: number) => void): Promise<{ emptyPages: number[]; preview: string }>;
  sha256?: string;
  allowImages?: boolean;
  pageCount: number;
  readPages(pages: number[]): Promise<{ pages: { page: number; text: string }[]; emptyPages: number[] }>;
  close(): Promise<void>;
}

export async function pickPdf(
  app: App,
  openDocument: (path: string) => Promise<PdfDocument>,
  initialFile?: TFile,
): Promise<SourceContext | null> {
  const file = initialFile ?? await selectPdf(app);
  if (!file) return null;
  const result = await new Promise<SourceContext | null | 'choose-file'>(resolve => new PdfPagesModal(app, file, openDocument, resolve).open());
  return result === 'choose-file' ? pickPdf(app, openDocument) : result;
}

function selectPdf(app: App): Promise<TFile | null> {
  return new Promise(resolve => {
    class Picker extends FuzzySuggestModal<TFile> {
      private selected = false;
      getItems(): TFile[] { return app.vault.getFiles().filter(file => file.extension.toLowerCase() === 'pdf'); }
      getItemText(file: TFile): string { return file.path; }
      onChooseItem(file: TFile): void { this.selected = true; resolve(file); }
      onClose(): void { queueMicrotask(() => { if (!this.selected) resolve(null); }); }
    }
    const picker = new Picker(app);
    picker.setPlaceholder('选择要学习的 PDF');
    picker.open();
  });
}

function parsePages(input: string, pageCount: number, limit = MAX_PDF_PAGES): number[] {
  const value = input.trim();
  if (value.toLowerCase() === 'all') {
    if (pageCount > limit) throw new Error(`一次最多提取 ${limit} 页，请选择范围。`);
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const pages = new Set<number>();
  for (const part of value.split(/[,，]/)) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new Error('请输入页码范围，例如 1-3,5。');
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > pageCount || end < start) {
      throw new Error(`页码必须在 1-${pageCount} 之间，范围起点不能大于终点。`);
    }
    // Bound work before expanding user input, including very large ranges.
    if (end - start + 1 > limit) throw new Error(`一次最多提取 ${limit} 页，请缩小页码范围。`);
    for (let page = start; page <= end; page++) {
      pages.add(page);
      if (pages.size > limit) throw new Error(`一次最多提取 ${limit} 页，请缩小页码范围。`);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function buildContext(file: TFile, document: PdfDocument, requested: number[], result: Awaited<ReturnType<PdfDocument['readPages']>>): SourceContext {
  const textByPage = new Map(result.pages.map(page => [page.page, page.text]));
  if (result.pages.length !== requested.length || textByPage.size !== requested.length || requested.some(page => !textByPage.has(page))) {
    throw new Error('PDF 提取结果缺少所选页面，请重试。');
  }
  const emptyPages = requested.filter(page => !textByPage.get(page)!.trim());
  if (!document.allowImages && emptyPages.length === requested.length) {
    throw new Error('所选页面没有可提取的文字，可能是扫描版 PDF。请先进行 OCR 或选择其他页面。');
  }
  const selectedText = pdfPageText(file.path, requested.map(page => ({ page, text: textByPage.get(page)! })));
  if (selectedText.length > MAX_PDF_TEXT) {
    throw new Error(`提取结果含页码标记和来源链接超过 ${MAX_PDF_TEXT.toLocaleString()} 个字符，请缩小页码范围。`);
  }
  return {
    sourcePath: file.path, sourceName: file.basename, selectedText, before: '', after: '',
    from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 },
    pdf: { ...(document.sha256 ? { sha256: document.sha256 } : {}), pageCount: document.pageCount, pages: [...requested], emptyPages },
  };
}

interface ReadRequest { generation: number; pages: number[] }

class PdfPagesModal extends Modal {
  private document?: PdfDocument;
  private closed = false;
  private opening = false;
  private reading = false;
  private composing = false;
  private generation = 0;
  private readAbort?: AbortController;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private queuedRead?: ReadRequest;
  private activeRead?: Promise<void>;
  private context?: SourceContext;
  private accepted: SourceContext | null = null;
  private changingFile = false;
  private input!: HTMLInputElement;
  private useButton!: HTMLButtonElement;
  private retryButton!: HTMLButtonElement;
  private summary!: HTMLElement;
  private status!: HTMLElement;
  private help!: HTMLElement;
  private details!: HTMLDetailsElement;
  private preview!: HTMLTextAreaElement;

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly openDocument: (path: string) => Promise<PdfDocument>,
    private readonly resolve: (context: SourceContext | null | 'choose-file') => void,
  ) { super(app); }

  onOpen(): void {
    this.contentEl.classList.add('study-companion-pdf-picker');
    const dom = this.contentEl.ownerDocument;
    const heading = dom.createElement('h2');
    heading.textContent = '选择 PDF 页面';
    const source = dom.createElement('button');
    source.type = 'button';
    source.className = 'study-companion-pdf-file';
    source.title = '更换 PDF';
    source.setAttribute('aria-label', `更换 PDF：${this.file.path}`);
    source.textContent = this.file.path;
    source.addEventListener('click', () => { this.changingFile = true; this.close(); });
    this.summary = dom.createElement('p');
    this.summary.className = 'study-companion-pdf-summary';
    this.summary.textContent = '正在读取 PDF…';
    const label = dom.createElement('label');
    label.textContent = '页码';
    this.input = dom.createElement('input');
    this.input.type = 'text';
    this.input.placeholder = '例如 1-20,25';
    this.input.setAttribute('aria-label', 'PDF 页码范围');
    this.input.addEventListener('input', () => this.onRangeInput());
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; });
    this.input.addEventListener('keydown', event => this.onKeydown(event));
    label.append(this.input);
    const help = dom.createElement('p');
    this.help = help;
    help.textContent = `页码按文件顺序从 1 开始，一次最多 ${MAX_PDF_PAGES} 页。只读取文本；扫描页需先 OCR，图表、公式和多栏内容可能不完整。`;
    this.status = dom.createElement('p');
    this.status.className = 'study-companion-pdf-status';
    this.status.setAttribute('role', 'status');
    this.details = dom.createElement('details');
    this.details.className = 'study-companion-pdf-details';
    this.details.hidden = true;
    const detailsSummary = dom.createElement('summary');
    detailsSummary.textContent = '查看提取文本';
    this.preview = dom.createElement('textarea');
    this.preview.readOnly = true;
    this.preview.rows = 12;
    this.preview.style.width = '100%';
    this.preview.setAttribute('aria-label', 'PDF 提取文本预览');
    this.details.append(detailsSummary, this.preview);
    this.retryButton = dom.createElement('button');
    this.retryButton.textContent = '重试';
    this.retryButton.className = 'study-companion-pdf-retry';
    this.retryButton.hidden = true;
    this.retryButton.addEventListener('click', () => this.retry());
    this.useButton = dom.createElement('button');
    this.useButton.textContent = '使用所选页面';
    this.useButton.className = 'mod-cta';
    this.useButton.disabled = true;
    this.useButton.addEventListener('click', () => this.accept());
    const cancel = dom.createElement('button');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => this.close());
    const actions = dom.createElement('div'); actions.className = 'study-companion-note-actions';
    actions.append(cancel, this.retryButton, this.useButton);
    this.contentEl.replaceChildren(heading, source, this.summary, label, help, this.status, this.details, actions);
    void this.load();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.readAbort?.abort();
    this.generation++;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.queuedRead = undefined;
    this.contentEl.replaceChildren();
    if (!this.accepted) this.resolve(this.changingFile ? 'choose-file' : null);
    void this.finishClose();
  }

  private onRangeInput(): void {
    if (this.closed || !this.document) return;
    this.invalidate();
    this.status.textContent = '正在准备所选页面…';
    const generation = this.generation;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.prepareRead(generation);
    }, RANGE_DEBOUNCE_MS);
  }

  private onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || this.composing || !this.context || this.reading) return;
    event.preventDefault();
    this.accept();
  }

  private accept(): void {
    if (this.closed || this.reading || !this.context) return;
    this.accepted = this.context;
    this.close();
  }

  private retry(): void {
    if (this.closed || this.opening) return;
    this.retryButton.hidden = true;
    this.invalidate();
    if (!this.document) { void this.load(); return; }
    this.prepareRead(this.generation);
  }

  private invalidate(): void {
    this.readAbort?.abort();
    this.generation++;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    this.queuedRead = undefined;
    this.context = undefined;
    this.preview.value = '';
    this.details.hidden = true;
    this.details.open = false;
    this.useButton.disabled = true;
    this.retryButton.hidden = true;
  }

  private async load(): Promise<void> {
    if (this.closed || this.opening || this.document) return;
    this.opening = true;
    this.input.disabled = true;
    this.useButton.disabled = true;
    this.retryButton.hidden = true;
    this.status.textContent = '正在打开 PDF…';
    try {
      const document = await this.openDocument(this.file.path);
      if (this.closed) {
        await this.release(document);
        return;
      }
      if (!Number.isSafeInteger(document.pageCount) || document.pageCount < 1) {
        await this.release(document);
        throw new Error('PDF 没有有效页面，请重新选择文件。');
      }
      this.document = document;
      if (document.readIndexed) this.help.textContent = '逐页导入并缓存原文，后续按主题和问题选择证据；不会一次发送整份 PDF。更改范围或关闭可中断，再次导入会继续已完成页面。无文字页面会明确标注，不推测其内容。';
      if (document.allowImages && !document.readIndexed) this.help.textContent = `页码按文件顺序从 1 开始，一次最多 ${MAX_PDF_PAGES} 页。学习模式的证据问答可按需查看已选页图片；文字预览可能缺少图表、公式和扫描内容。`;
      this.summary.textContent = `共 ${document.pageCount} 页`;
      this.input.disabled = false;
      if (document.pageCount <= (document.readIndexed ? 10_000 : MAX_PDF_PAGES)) {
        this.input.value = document.pageCount === 1 ? '1' : `1-${document.pageCount}`;
        this.input.focus();
        this.invalidate();
        this.queueRead({ generation: this.generation, pages: Array.from({ length: document.pageCount }, (_, index) => index + 1) });
      } else {
        this.input.value = '';
        this.status.textContent = `文档超过 ${MAX_PDF_PAGES} 页，请输入要使用的页码范围。`;
        this.input.focus();
      }
    } catch (error) {
      if (!this.closed) this.showError(`打开失败：${error instanceof Error ? error.message : '无法读取 PDF。'}`);
    } finally {
      this.opening = false;
      if (!this.closed) this.input.disabled = false;
    }
  }

  private prepareRead(generation: number): void {
    if (this.closed || !this.document || generation !== this.generation) return;
    try {
      this.queueRead({ generation, pages: parsePages(this.input.value, this.document.pageCount, this.document.readIndexed ? 10_000 : MAX_PDF_PAGES) });
    } catch (error) {
      this.showError(error instanceof Error ? error.message : '页码范围无效。');
    }
  }

  private queueRead(request: ReadRequest): void {
    if (this.closed || request.generation !== this.generation) return;
    this.queuedRead = request;
    this.status.textContent = this.activeRead ? '页码已更新，等待读取…' : '正在读取所选页面…';
    void this.drainReads();
  }

  private async drainReads(): Promise<void> {
    if (this.closed || this.activeRead || !this.queuedRead || !this.document) return;
    const request = this.queuedRead;
    this.queuedRead = undefined;
    this.reading = true;
    const active = this.runRead(this.document, request);
    this.activeRead = active;
    await active;
    if (this.activeRead === active) this.activeRead = undefined;
    this.reading = false;
    if (!this.closed && this.queuedRead) void this.drainReads();
  }

  private async runRead(document: PdfDocument, request: ReadRequest): Promise<void> {
    try {
      this.readAbort = new AbortController();
      if (document.readIndexed) {
        const result = await document.readIndexed(request.pages, this.readAbort.signal, done => {
          if (!this.closed && request.generation === this.generation) this.status.textContent = `正在导入 ${done}/${request.pages.length} 页 · 已完成页面自动保留`;
        });
        if (this.closed || request.generation !== this.generation || document !== this.document) return;
        if (!document.sha256) throw new Error('缺少 PDF 文件指纹。');
        if (!document.allowImages && result.emptyPages.length === request.pages.length) throw new Error('所选页面没有可提取文字，请使用图文证据问答或先 OCR。');
        this.context = { sourcePath: this.file.path, sourceName: this.file.basename,
          selectedText: `已导入 ${request.pages.length} 页；全文保存在本地页面缓存，回答前按任务读取。`, before: '', after: '',
          from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 },
          pdf: { indexed: true, sha256: document.sha256, pageCount: document.pageCount, pages: request.pages, emptyPages: result.emptyPages } };
        this.preview.value = result.preview;
      } else {
        const result = await document.readPages(request.pages);
      if (this.closed || request.generation !== this.generation || document !== this.document) return;
      this.context = buildContext(this.file, document, request.pages, result);
      this.preview.value = this.context.selectedText;
      }
      this.details.hidden = false;
      const emptyPages = this.context.pdf!.emptyPages;
      this.status.textContent = `已就绪 · ${request.pages.length} 页${document.readIndexed ? ' · 原文已逐页缓存' : ` · ${this.context.selectedText.length.toLocaleString()} 字符`}${emptyPages.length ? `。${emptyPages.length <= 20 ? `第 ${emptyPages.join('、')} 页` : `${emptyPages.length} 页`}无文本，${document.allowImages ? '证据问答可按需查看页面图片' : '扫描内容需 OCR'}。` : ''}`;
      this.useButton.disabled = false;
      this.retryButton.hidden = true;
    } catch (error) {
      if (!this.closed && request.generation === this.generation && document === this.document) {
        this.showError(`读取失败：${error instanceof Error ? error.message : '无法提取 PDF 文本。'}`);
      }
    }
  }

  private showError(message: string): void {
    if (this.closed) return;
    this.context = undefined;
    this.preview.value = '';
    this.details.hidden = true;
    this.useButton.disabled = true;
    this.status.textContent = `${message} 可以重试。`;
    this.retryButton.hidden = false;
  }

  private async finishClose(): Promise<void> {
    if (this.activeRead) await this.activeRead;
    if (this.document) await this.release(this.document);
    if (this.accepted) this.resolve(this.accepted);
  }

  private async release(document: PdfDocument): Promise<void> {
    try { await document.close(); }
    catch { new Notice('PDF 操作已结束，但释放文档资源时出错。'); }
  }
}
