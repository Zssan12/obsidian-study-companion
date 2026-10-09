import type { CramDocument, CramInput, CramReader } from '../../core/cram';
import { CRAM_LIMITS, validateCramInputs } from '../../core/cram';
import { PdfReader, type PdfJsLoader } from './PdfReader';

/** Reads only the explicitly selected binary snapshot; never imports it into chat history. */
export class CramPdfReader implements CramReader {
  constructor(private readonly loadPdfJs?: PdfJsLoader) {}
  async open(input: CramInput, readImages: boolean, signal: AbortSignal): Promise<CramDocument> {
    validateCramInputs([input]);
    signal.throwIfAborted();
    const bytes = await input.arrayBuffer();
    signal.throwIfAborted();
    if (bytes.byteLength !== input.size || bytes.byteLength > CRAM_LIMITS.fileBytes) throw new Error('课件大小发生变化，请重新选择。');
    const pdf = await new PdfReader(async () => bytes, this.loadPdfJs).open('cram-source.pdf', { allowEmpty: true });
    try {
      signal.throwIfAborted();
      if (pdf.pageCount > CRAM_LIMITS.pages) throw new Error('单份课件超过 600 页，请拆分后处理。');
      return {
        sha256: pdf.sha256, pageCount: pdf.pageCount,
        notice: readImages ? '读取方式：逐页文字与图片。图中细小公式或数字仍需对照原文核查。'
          : '读取方式：页面文字，无文字页补充图片；有文字页中的图表未逐页读取。图表较多时请选择“逐页读取图表”重新生成。',
        readPage: async (page, pageSignal) => {
          pageSignal.throwIfAborted();
          const result = await pdf.readPages([page]);
          pageSignal.throwIfAborted();
          const text = result.pages[0]!.text;
          const rendered = readImages || !text.trim() ? await pdf.renderPage(page) : undefined;
          const image = rendered ? { ...rendered, label: `${input.name.slice(0, 150)} · 第 ${page} 页` } : undefined;
          pageSignal.throwIfAborted();
          return { page, text, image, ...(!image ? { warning: '仅提供此页提取文字，未提供此页图片。' } : {}) };
        },
        close: () => pdf.close(),
      };
    } catch (error) { await pdf.close(); throw error; }
  }
}
