import type { ContextCache, DocumentLibrary, DocumentPage } from '../core/context';
import { checkCancelled } from './context-budget';
import { isOcrText } from '../core/ocr';

export function documentPageText(page: DocumentPage): string {
  if (!page.ocr?.text.trim()) return page.text;
  return page.text + '\n[以下是本地 OCR 识别文字，可能有误；置信度 ' + page.ocr.confidence.toFixed(0)
    + '/100 不是准确率。图表关系、公式与精确数值需核对原图。]\n' + page.ocr.text;
}

export class CachedDocumentLibrary implements DocumentLibrary {
  constructor(private readonly cache: ContextCache) {}
  private key(sha: string, page: number): string {
    if (!/^[a-f0-9]{64}$/u.test(sha) || !Number.isSafeInteger(page) || page < 1) throw new Error('PDF 缓存标识无效。');
    return `pdf-page-v1:${sha}:${page}`;
  }
  async get(sha: string, page: number): Promise<DocumentPage | undefined> {
    const raw = await this.cache.get(this.key(sha, page));
    if (raw === undefined) return undefined;
    const value = JSON.parse(raw) as DocumentPage;
    if (value.page !== page || typeof value.text !== 'string') throw new Error('PDF 页面缓存损坏，请重新导入。');
    if (value.ocr !== undefined && (!isOcrText(value.ocr) || typeof value.ocr.configuration !== 'string')) throw new Error('PDF OCR 缓存损坏，请重新导入。');
    return value;
  }
  async put(sha: string, page: DocumentPage): Promise<void> { await this.cache.set(this.key(sha, page.page), JSON.stringify(page)); }
  async read(sha: string, pages: readonly number[], signal: AbortSignal): Promise<DocumentPage[]> {
    const result: DocumentPage[] = [];
    for (const page of pages) {
      checkCancelled(signal); const value = await this.get(sha, page);
      if (!value) throw new Error(`第 ${page} 页缓存不存在，请重新导入原 PDF；不会用其他版本替代。`);
      result.push({ ...value, text: documentPageText(value) });
    }
    return result;
  }
}
