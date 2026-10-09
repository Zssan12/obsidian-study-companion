import { createHash } from 'node:crypto';
import { isPageRegion, type EvidenceImage, type PageRegion } from '../../core/pdf-agent';
import { loadPdfJs as loadObsidianPdfJs } from 'obsidian';

export const MAX_PDF_BYTES = 256 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_PDF_TEXT = 60_000;

export type PdfReaderErrorCode =
  | 'invalid-path'
  | 'file-too-large'
  | 'invalid-pdf'
  | 'password-required'
  | 'invalid-pages'
  | 'too-many-pages'
  | 'text-too-large'
  | 'empty-pdf'
  | 'closed';

export class PdfReaderError extends Error {
  constructor(readonly code: PdfReaderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PdfReaderError';
  }
}

export interface PdfPageText {
  page: number;
  text: string;
}

export interface PdfReadPagesResult {
  pages: PdfPageText[];
  emptyPages: number[];
}

export interface PdfDocument {
  sha256: string;
  renderPage(page: number, region?: PageRegion): Promise<EvidenceImage>;
  pageCount: number;
  readPages(pages: number[]): Promise<PdfReadPagesResult>;
  close(): Promise<void>;
}

export interface PdfJsTextItem {
  str: string;
  hasEOL?: boolean;
  transform?: readonly number[];
}

export interface PdfJsTextContent {
  items: readonly unknown[];
}

export interface PdfJsPage {
  getViewport?(options: { scale: number }): { width: number; height: number };
  render?(options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number }; transform?: number[] }): { promise: Promise<void> };
  getTextContent(): Promise<PdfJsTextContent>;
  cleanup(): void | boolean;
}

export interface PdfJsDocument {
  numPages: number;
  getPage(page: number): Promise<PdfJsPage>;
  cleanup(): void | Promise<void>;
  destroy(): void | Promise<void>;
}

export interface PdfJsLoadingTask {
  promise: Promise<PdfJsDocument>;
  destroy(): void | Promise<void>;
}

export interface PdfJsLibrary {
  getDocument(options: { data: Uint8Array; isEvalSupported: false }): PdfJsLoadingTask;
}

export type PdfJsLoader = () => Promise<PdfJsLibrary>;
export type PdfBinaryReader = (path: string) => Promise<ArrayBuffer>;

/** Reads only vault-relative PDF data supplied by the composition root. */
export class PdfReader {
  constructor(
    private readonly readBinary: PdfBinaryReader,
    private readonly loadPdfJs: PdfJsLoader = loadObsidianPdfJs as PdfJsLoader,
  ) {}

  async open(path: string, options: { allowEmpty?: boolean } = {}): Promise<PdfDocument> {
    assertVaultRelativePath(path);

    const data = await this.readBinary(path);
    if (data.byteLength > MAX_PDF_BYTES) {
      throw new PdfReaderError(
        'file-too-large',
        `PDF 大小不能超过 256 MB（本地解析内存限制）；当前文件为 ${formatMegabytes(data.byteLength)} MB。`,
      );
    }

    const sha256 = createHash('sha256').update(new Uint8Array(data)).digest('hex');
    let loadingTask: PdfJsLoadingTask | undefined;
    try {
      const pdfJs = await this.loadPdfJs();
      loadingTask = pdfJs.getDocument({ data: new Uint8Array(data), isEvalSupported: false });
      const document = await loadingTask.promise;
      if (!Number.isInteger(document.numPages) || document.numPages < 1) {
        await destroyDocument(document);
        throw new PdfReaderError('invalid-pdf', '无法打开 PDF：文件没有可读取的页面，可能已损坏。');
      }
      return createDocument(document, sha256, options.allowEmpty === true);
    } catch (error) {
      await destroyLoadingTask(loadingTask);
      throw readableOpenError(error);
    }
  }
}

function createDocument(document: PdfJsDocument, sha256: string, allowEmpty: boolean): PdfDocument {
  let closed = false;

  return {
    pageCount: document.numPages,
    sha256,
    async renderPage(pageNumber, region) {
      if (closed) throw new PdfReaderError('closed', 'PDF 已关闭。');
      validatePages([pageNumber], document.numPages);
      if (region && !isPageRegion(region)) throw new Error('图片区域无效。');
      const page = await document.getPage(pageNumber);
      try { return await renderImage(page, region); } finally { page.cleanup(); }
    },

    async readPages(requestedPages: number[]): Promise<PdfReadPagesResult> {
      if (closed) throw new PdfReaderError('closed', 'PDF 已关闭，无法继续读取。');
      validatePages(requestedPages, document.numPages);

      const pages: PdfPageText[] = [];
      const emptyPages: number[] = [];
      let extractedCharacters = 0;

      for (const pageNumber of requestedPages) {
        let page: PdfJsPage | undefined;
        try {
          page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const text = extractText(content, MAX_PDF_TEXT - extractedCharacters);
          extractedCharacters += text.length;
          pages.push({ page: pageNumber, text });
          if (!text) emptyPages.push(pageNumber);
        } catch (error) {
          if (error instanceof PdfReaderError) throw error;
          throw new PdfReaderError(
            'invalid-pdf',
            `无法读取 PDF 第 ${pageNumber} 页：页面内容可能已损坏。`,
            { cause: error },
          );
        } finally {
          page?.cleanup();
        }
      }

      if (!allowEmpty && emptyPages.length === requestedPages.length) {
        throw new PdfReaderError(
          'empty-pdf',
          '所选 PDF 页面没有可提取的文字，可能是扫描版 PDF。请改选含文本的页面或先进行 OCR。',
        );
      }

      return { pages, emptyPages };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await destroyDocument(document);
    },
  };
}

function validatePages(pages: number[], pageCount: number): void {
  if (pages.length === 0) {
    throw new PdfReaderError('invalid-pages', '请至少选择一个 PDF 页码。');
  }
  if (pages.length > MAX_PDF_PAGES) {
    throw new PdfReaderError(
      'too-many-pages',
      `一次最多读取 ${MAX_PDF_PAGES} 页；请缩小页码范围后重试。`,
    );
  }

  const uniquePages = new Set<number>();
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new PdfReaderError('invalid-pages', `页码 ${String(page)} 无效；有效范围是 1–${pageCount}。`);
    }
    if (uniquePages.has(page)) {
      throw new PdfReaderError('invalid-pages', `页码 ${page} 重复；每页只能选择一次。`);
    }
    uniquePages.add(page);
  }
}

function extractText(content: PdfJsTextContent, remainingCharacters: number): string {
  let text = '';
  let previousY: number | undefined;
  let previousHadEol = false;

  for (const value of content.items) {
    if (!isTextItem(value)) continue;

    const y = coordinateY(value);
    const lineChanged = previousY !== undefined && y !== undefined && Math.abs(y - previousY) > 1;
    const separator = text && (previousHadEol || lineChanged) && !text.endsWith('\n') ? '\n' : '';
    const addition = separator + value.str;

    if (text.length + addition.length > remainingCharacters) {
      throw new PdfReaderError(
        'text-too-large',
        `所选 PDF 文本超过 ${MAX_PDF_TEXT.toLocaleString()} 个字符；请缩小页码范围后重试。`,
      );
    }

    text += addition;
    previousHadEol = value.hasEOL === true;
    if (y !== undefined) previousY = y;
  }

  return text.trim();
}

function isTextItem(value: unknown): value is PdfJsTextItem {
  return typeof value === 'object' && value !== null && typeof (value as { str?: unknown }).str === 'string';
}

function coordinateY(item: PdfJsTextItem): number | undefined {
  const y = item.transform?.[5];
  return typeof y === 'number' && Number.isFinite(y) ? y : undefined;
}

function assertVaultRelativePath(path: string): void {
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').includes('..')
    || /^[A-Za-z]:/.test(path)
  ) {
    throw new PdfReaderError('invalid-path', 'PDF 路径必须是 vault 内的相对路径。');
  }
}

async function destroyDocument(document: PdfJsDocument): Promise<void> {
  let cleanupError: unknown;
  try {
    await document.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  await document.destroy();
  if (cleanupError !== undefined) throw cleanupError;
}

async function destroyLoadingTask(task: PdfJsLoadingTask | undefined): Promise<void> {
  try {
    await task?.destroy();
  } catch {
    // Keep the original PDF opening error; loading-task cleanup is best effort.
  }
}

function readableOpenError(error: unknown): PdfReaderError {
  if (error instanceof PdfReaderError) return error;
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (/password/i.test(name) || /password|encrypted|encryption/i.test(message)) {
    return new PdfReaderError(
      'password-required',
      '无法打开加密 PDF。请先移除密码保护，再重新选择文件。',
      { cause: error },
    );
  }
  return new PdfReaderError(
    'invalid-pdf',
    '无法打开 PDF：文件可能已损坏或不是有效的 PDF。',
    { cause: error },
  );
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Render only the requested region; bound both dimensions before allocating a canvas. */
async function renderImage(page: PdfJsPage, region?: PageRegion): Promise<EvidenceImage> {
  if (!page.getViewport || !page.render) throw new Error('当前 PDF.js 不支持页面渲染。');
  const rect = region ?? { x: 0, y: 0, width: 1, height: 1 };
  const base = page.getViewport({ scale: 1 });
  if (![base.width, base.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('PDF 页面尺寸无效。');
  const scale = Math.min(3, 1600 / Math.max(base.width * rect.width, base.height * rect.height));
  const viewport = page.getViewport({ scale });
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width * rect.width);
  canvas.height = Math.ceil(viewport.height * rect.height);
  if (canvas.width < 1 || canvas.height < 1 || canvas.width > 1601 || canvas.height > 1601) throw new Error('PDF 渲染尺寸超过预算。');
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 PDF 页面画布。');
    await page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, -rect.x * viewport.width, -rect.y * viewport.height] }).promise;
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (!data || data.length > 4_000_000) throw new Error('PDF 图片超过预算，请选择较小区域。');
    return { data, mimeType: 'image/png', label: 'PDF page' };
  } finally { canvas.width = 0; canvas.height = 0; }
}
