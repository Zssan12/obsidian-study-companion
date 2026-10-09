import { expect, it, vi } from 'vitest';
import { indexPdfPages } from '../../src/application/index-pdf-pages';
import { CachedDocumentLibrary } from '../../src/application/DocumentLibrary';
import type { EvidenceDocument } from '../../src/core/pdf-agent';
import { parseTesseractTsv, TesseractOcr } from '../../src/adapters/ocr/TesseractOcr';

function fixture(texts = ['', '3', 'Native text that already describes the complete source page.']) {
  const cache = new Map<string, string>();
  const library = new CachedDocumentLibrary({ get: async key => cache.get(key), set: async (key, value) => { cache.set(key, value); } });
  const document: EvidenceDocument = { sha256: 'a'.repeat(64), pageCount: texts.length,
    readPages: vi.fn(async (pages: number[]) => ({ pages: pages.map(page => ({ page, text: texts[page - 1]! })), emptyPages: [] })),
    renderPage: vi.fn(async page => ({ data: 'image', mimeType: 'image/png' as const, label: String(page) })), close: async () => {} };
  const ocr = { configuration: 'engine-v1:eng+chi_sim', recognize: vi.fn(async () => ({ text: '识别出的文字 42', confidence: 91 })) };
  const abort = new AbortController(); const progress = vi.fn();
  const run = () => indexPdfPages(document, texts.map((_, i) => i + 1), library, abort.signal, progress, ocr);
  return { library, document, ocr, abort, run, progress };
}

it('recognizes scanned pages, preserves native text, and resumes from a versioned per-page cache', async () => {
  const f = fixture();
  const result = await f.run();
  expect(result.emptyPages).toEqual([]);
  expect(f.ocr.recognize).toHaveBeenCalledTimes(2);
  expect(result.preview).toContain('OCR');
  expect((await f.library.get(f.document.sha256, 2))?.text).toBe('3');
  expect((await f.library.read(f.document.sha256, [1, 2], f.abort.signal))[0]?.text).toContain('42');
  await f.run(); expect(f.ocr.recognize).toHaveBeenCalledTimes(2);
  f.ocr.configuration = 'engine-v1:eng'; await f.run(); expect(f.ocr.recognize).toHaveBeenCalledTimes(4);
  f.document.sha256 = 'b'.repeat(64); await f.run(); expect(f.ocr.recognize).toHaveBeenCalledTimes(6);
});

it('does not write cancelled OCR results or continue to the next page', async () => {
  const f = fixture();
  f.ocr.recognize.mockImplementation(async () => { f.abort.abort(); return { text: 'cancelled', confidence: 95 }; });
  await expect(f.run()).rejects.toThrow();
  expect(f.document.renderPage).toHaveBeenCalledOnce();
  expect((await f.library.get(f.document.sha256, 1))?.ocr).toBeUndefined();
});

it('keeps blank OCR pages explicitly uncovered and does not repeatedly recognize them', async () => {
  const f = fixture(['']); f.ocr.recognize.mockResolvedValue({ text: '', confidence: 0 });
  expect((await f.run()).emptyPages).toEqual([1]);
  await f.run(); expect(f.ocr.recognize).toHaveBeenCalledOnce();
});

it('does not silently downgrade failed recognition to an ordinary text answer', async () => {
  const f = fixture(['']); f.ocr.recognize.mockRejectedValue(new Error('language missing'));
  await expect(f.run()).rejects.toThrow('language missing');
  expect((await f.library.get(f.document.sha256, 1))?.ocr).toBeUndefined();
});

it('retains line order and confidence from the actual TSV word protocol', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const row = (line: number, word: number, score: number, text: string) => ['5', '1', '1', '1', line, word, 0, 0, 10, 10, score, text].join('\t');
  expect(parseTesseractTsv([header, row(1, 1, 90, 'Hello'), row(1, 2, 80, '世界'), row(2, 1, 100, '42')].join('\n')))
    .toEqual({ text: 'Hello 世界\n42', confidence: 90 });
  expect(() => parseTesseractTsv('garbage')).toThrow();
  expect(() => new TesseractOcr('tesseract; curl invalid')).toThrow();
  expect(() => new TesseractOcr('/usr/bin/tesseract', 'eng --evil')).toThrow();
});
