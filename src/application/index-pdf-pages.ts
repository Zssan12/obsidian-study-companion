import type { EvidenceDocument } from '../core/pdf-agent';
import type { LocalOcrPort } from '../core/ocr';
import { CachedDocumentLibrary, documentPageText } from './DocumentLibrary';
import { checkCancelled } from './context-budget';

/** Native text stays intact. OCR is an explicitly labelled derivative of the same binary page. */
export async function indexPdfPages(document: EvidenceDocument, pages: number[], library: CachedDocumentLibrary,
  signal: AbortSignal, progress: (done: number) => void, ocr?: LocalOcrPort): Promise<{ emptyPages: number[]; preview: string }> {
  const emptyPages: number[] = []; let preview = '';
  for (const [index, page] of pages.entries()) {
    checkCancelled(signal);
    let cached = await library.get(document.sha256, page);
    if (!cached) {
      cached = (await document.readPages([page])).pages[0]!;
      checkCancelled(signal); await library.put(document.sha256, cached);
    }
    // A lone page number/title often accompanies a scanned body; preserve it alongside OCR.
    if (ocr && cached.text.trim().length < 32 && cached.ocr?.configuration !== ocr.configuration) {
      const image = await document.renderPage(page); checkCancelled(signal);
      const result = await ocr.recognize(image, signal); checkCancelled(signal);
      cached = { ...cached, ocr: { ...result, configuration: ocr.configuration } };
      await library.put(document.sha256, cached);
    }
    const text = documentPageText(cached);
    if (!text.trim()) emptyPages.push(page);
    if (preview.length < 12_000) preview += '第 ' + page + ' 页\n' + text.slice(0, 12_000 - preview.length) + '\n\n';
    progress(index + 1);
  }
  return { emptyPages, preview: preview + '\n[仅预览开头片段，完整文字已按页缓存；OCR 内容单独标记]' };
}
