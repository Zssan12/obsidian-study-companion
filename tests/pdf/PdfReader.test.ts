import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  MAX_PDF_TEXT,
  PdfReader,
  PdfReaderError,
  type PdfJsDocument,
  type PdfJsLibrary,
  type PdfJsLoadingTask,
  type PdfJsPage,
  type PdfJsTextContent,
} from '../../src/adapters/obsidian/PdfReader';

interface FakePdf {
  reader: PdfReader;
  getDocument: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
  documentCleanup: ReturnType<typeof vi.fn>;
  documentDestroy: ReturnType<typeof vi.fn>;
  loadingDestroy: ReturnType<typeof vi.fn>;
  pageCleanups: ReturnType<typeof vi.fn>[];
}

function fakePdf(pageItems: unknown[][]): FakePdf {
  const pageCleanups = pageItems.map(() => vi.fn());
  const getPage = vi.fn(async (pageNumber: number): Promise<PdfJsPage> => ({
    getTextContent: async (): Promise<PdfJsTextContent> => ({ items: pageItems[pageNumber - 1] ?? [] }),
    cleanup: pageCleanups[pageNumber - 1] ?? vi.fn(),
  }));
  const documentCleanup = vi.fn();
  const documentDestroy = vi.fn();
  const document: PdfJsDocument = {
    numPages: pageItems.length,
    getPage,
    cleanup: documentCleanup,
    destroy: documentDestroy,
  };
  const loadingDestroy = vi.fn();
  const task: PdfJsLoadingTask = { promise: Promise.resolve(document), destroy: loadingDestroy };
  const getDocument = vi.fn(() => task);
  const library: PdfJsLibrary = { getDocument };
  const reader = new PdfReader(async () => new ArrayBuffer(16), async () => library);
  return { reader, getDocument, getPage, documentCleanup, documentDestroy, loadingDestroy, pageCleanups };
}

describe('PdfReader', () => {
  it('uses the safe PDF.js options and extracts requested pages sequentially with line breaks', async () => {
    const pdf = fakePdf([
      [
        { str: 'First', transform: [1, 0, 0, 1, 0, 20], hasEOL: true },
        { str: 'Second', transform: [1, 0, 0, 1, 0, 20] },
        { str: 'Third', transform: [1, 0, 0, 1, 0, 10] },
      ],
      [{ str: 'Page two', transform: [1, 0, 0, 1, 0, 20] }],
      [{ str: 'Page three', transform: [1, 0, 0, 1, 0, 20] }],
    ]);

    const document = await pdf.reader.open('books/example.pdf');
    const result = await document.readPages([3, 1]);

    expect(document.pageCount).toBe(3);
    expect(result).toEqual({
      pages: [
        { page: 3, text: 'Page three' },
        { page: 1, text: 'First\nSecond\nThird' },
      ],
      emptyPages: [],
    });
    expect(pdf.getPage.mock.calls.map(([page]) => page)).toEqual([3, 1]);
    expect(pdf.getDocument).toHaveBeenCalledOnce();
    expect(pdf.getDocument.mock.calls[0]?.[0]).toMatchObject({ isEvalSupported: false });
    expect(pdf.getDocument.mock.calls[0]?.[0].data).toBeInstanceOf(Uint8Array);
    expect(pdf.pageCleanups[2]).toHaveBeenCalledOnce();
    expect(pdf.pageCleanups[0]).toHaveBeenCalledOnce();

    await document.close();
    await document.close();
    expect(pdf.documentCleanup).toHaveBeenCalledOnce();
    expect(pdf.documentDestroy).toHaveBeenCalledOnce();
  });

  it('reports partially empty pages while retaining their page entries', async () => {
    const pdf = fakePdf([
      [{ str: 'Readable' }],
      [{ type: 'beginMarkedContent', id: 'scan' }],
    ]);
    const document = await pdf.reader.open('mixed.pdf');

    await expect(document.readPages([1, 2])).resolves.toEqual({
      pages: [{ page: 1, text: 'Readable' }, { page: 2, text: '' }],
      emptyPages: [2],
    });
    expect(pdf.pageCleanups[0]).toHaveBeenCalledOnce();
    expect(pdf.pageCleanups[1]).toHaveBeenCalledOnce();
  });

  it('rejects all-empty selections with an OCR-oriented error', async () => {
    const pdf = fakePdf([[], []]);
    const document = await pdf.reader.open('scan.pdf');

    await expect(document.readPages([1, 2])).rejects.toMatchObject({ code: 'empty-pdf' } satisfies Partial<PdfReaderError>);
    expect(pdf.pageCleanups[0]).toHaveBeenCalledOnce();
    expect(pdf.pageCleanups[1]).toHaveBeenCalledOnce();
  });

  it('rejects invalid, duplicate, and oversized page selections before reading any page', async () => {
    const pdf = fakePdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => [{ str: 'text' }]));
    const document = await pdf.reader.open('book.pdf');

    await expect(document.readPages([0])).rejects.toMatchObject({ code: 'invalid-pages' } satisfies Partial<PdfReaderError>);
    await expect(document.readPages([1, 1])).rejects.toMatchObject({ code: 'invalid-pages' } satisfies Partial<PdfReaderError>);
    await expect(document.readPages(Array.from({ length: MAX_PDF_PAGES + 1 }, (_, index) => index + 1)))
      .rejects.toMatchObject({ code: 'too-many-pages' } satisfies Partial<PdfReaderError>);
    expect(pdf.getPage).not.toHaveBeenCalled();
  });

  it('rejects text beyond the total bound without truncating and still cleans the page', async () => {
    const pdf = fakePdf([[{ str: 'x'.repeat(MAX_PDF_TEXT + 1) }]]);
    const document = await pdf.reader.open('large-text.pdf');

    await expect(document.readPages([1])).rejects.toMatchObject({ code: 'text-too-large' } satisfies Partial<PdfReaderError>);
    expect(pdf.pageCleanups[0]).toHaveBeenCalledOnce();
  });

  it('rejects files beyond 256 MiB before loading PDF.js', async () => {
    const loader = vi.fn(async (): Promise<PdfJsLibrary> => { throw new Error('must not load'); });
    const reader = new PdfReader(async () => new ArrayBuffer(MAX_PDF_BYTES + 1), loader);

    await expect(reader.open('large.pdf')).rejects.toMatchObject({ code: 'file-too-large' } satisfies Partial<PdfReaderError>);
    expect(loader).not.toHaveBeenCalled();
  });

  it('rejects non-vault paths before invoking the binary reader', async () => {
    const readBinary = vi.fn(async () => new ArrayBuffer(8));
    const reader = new PdfReader(readBinary, async () => { throw new Error('must not load'); });

    await expect(reader.open('../outside.pdf')).rejects.toMatchObject({
      code: 'invalid-path',
    } satisfies Partial<PdfReaderError>);
    expect(readBinary).not.toHaveBeenCalled();
  });

  it('destroys a failed loading task and translates password errors', async () => {
    const loadingDestroy = vi.fn();
    const passwordError = Object.assign(new Error('Password required'), { name: 'PasswordException' });
    const library: PdfJsLibrary = {
      getDocument: () => ({ promise: Promise.reject(passwordError), destroy: loadingDestroy }),
    };
    const reader = new PdfReader(async () => new ArrayBuffer(8), async () => library);

    await expect(reader.open('protected.pdf')).rejects.toMatchObject({ code: 'password-required' } satisfies Partial<PdfReaderError>);
    expect(loadingDestroy).toHaveBeenCalledOnce();
  });

  it('cleans a page when extraction fails and releases the document when closed', async () => {
    const pageCleanup = vi.fn();
    const documentCleanup = vi.fn();
    const documentDestroy = vi.fn();
    const document: PdfJsDocument = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => { throw new Error('damaged stream'); },
        cleanup: pageCleanup,
      }),
      cleanup: documentCleanup,
      destroy: documentDestroy,
    };
    const library: PdfJsLibrary = {
      getDocument: () => ({ promise: Promise.resolve(document), destroy: vi.fn() }),
    };
    const pdf = await new PdfReader(async () => new ArrayBuffer(8), async () => library).open('damaged.pdf');

    await expect(pdf.readPages([1])).rejects.toMatchObject({ code: 'invalid-pdf' } satisfies Partial<PdfReaderError>);
    expect(pageCleanup).toHaveBeenCalledOnce();
    await pdf.close();
    expect(documentCleanup).toHaveBeenCalledOnce();
    expect(documentDestroy).toHaveBeenCalledOnce();
  });
});

it('supports explicitly enabled scan pages and binds them to a binary fingerprint', async () => {
  const pdf = fakePdf([[]]);
  const doc = await pdf.reader.open('scan.pdf', { allowEmpty: true });
  expect(doc.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(doc.readPages([1])).resolves.toEqual({ pages: [{ page: 1, text: '' }], emptyPages: [1] });
  await doc.close();
});

it('validates crop coordinates before loading a page and cleans render failures', async () => {
  const pdf = fakePdf([[{ str: 'text' }]]);
  const doc = await pdf.reader.open('chart.pdf');
  await expect(doc.renderPage(2)).rejects.toMatchObject({ code: 'invalid-pages' });
  await expect(doc.renderPage(1, { x: 0.9, y: 0, width: 0.5, height: 1 })).rejects.toThrow('区域');
  expect(pdf.getPage).not.toHaveBeenCalled();
  await expect(doc.renderPage(1)).rejects.toThrow('不支持');
  expect(pdf.pageCleanups[0]).toHaveBeenCalledOnce();
  await doc.close();
});

it('renders only a normalized crop, bounds allocation, and releases the canvas and page', async () => {
  const pdf = fakePdf([[{ str: 'text' }]]);
  const context = {};
  const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' };
  const render = vi.fn(() => {
    expect(canvas.width).toBe(1600); expect(canvas.height).toBe(800);
    return { promise: Promise.resolve() };
  });
  pdf.getPage.mockResolvedValue({ getTextContent: async () => ({ items: [] }), cleanup: pdf.pageCleanups[0],
    getViewport: ({ scale }: { scale: number }) => ({ width: 2000 * scale, height: 1000 * scale }), render });
  vi.stubGlobal('document', { createElement: () => canvas });
  const doc = await pdf.reader.open('chart.pdf');
  try {
    await expect(doc.renderPage(1, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).resolves.toMatchObject({ mimeType: 'image/png' });
    expect(render).toHaveBeenCalledWith({ canvasContext: context, viewport: { width: 3200, height: 1600 }, transform: [1, 0, 0, 1, -800, -400] });
    expect(canvas.width).toBe(0); expect(canvas.height).toBe(0);
    expect(pdf.pageCleanups[0]).toHaveBeenCalledOnce();
  } finally { await doc.close(); vi.unstubAllGlobals(); }
});
