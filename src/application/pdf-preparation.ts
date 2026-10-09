import type { SourceContext } from '../core/contracts';
import { checkCancelled } from './context-budget';

/** Only explicit file-order page requests narrow preparation; ambiguity keeps full coverage. */
export function requestedPdfPages(question: string): number[] | undefined {
  if (/(全文|全书|整份|整个文档|全部页面|所有页|其他页|其它页|其他章节|所有章节|whole\s+(?:document|book)|entire|all\s+pages|other\s+pages)/iu.test(question)
    || /(?:不要|不看|除了|除去|exclude|except|not)\s*(?:第|pages?\b)/iu.test(question)) return undefined;
  const group = '\\d+(?:\\s*(?:[-–—至到]\\s*(?:第\\s*)?\\d+|[,，、]\\s*\\d+))*';
  const pattern = new RegExp(`第\\s*(${group})\\s*页|\\bpages?\\s+(${group})(?![\\d.])`, 'giu');
  const pages = new Set<number>();
  for (const match of question.matchAll(pattern)) {
    const ranges = (match[1] ?? match[2]!).replace(/第\s*/gu, '').split(/[,，、]/u);
    for (const range of ranges) {
      const bounds = range.trim().split(/\s*[-–—至到]\s*/u).map(Number);
      if (bounds.length > 2) throw new Error('PDF 页码范围格式无效，请使用例如第 7-9 页。');
      const [start, end = start] = bounds as [number, number?];
      // Bound expansion before knowing the PDF's actual size.
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 10_000) throw new Error('PDF 页码范围无效，请使用从 1 开始的文件页序号。');
      for (let page = start; page <= end; page++) pages.add(page);
    }
  }
  return pages.size ? [...pages].sort((a, b) => a - b) : undefined;
}

export interface PreparationDocument {
  pageCount: number;
  sha256?: string;
  readIndexed?(pages: number[], signal: AbortSignal, progress: (done: number) => void): Promise<{emptyPages: number[]; preview: string}>;
  close(): Promise<void>;
}

export async function preparePdfSource(context: SourceContext, signal: AbortSignal, progress: (message: string) => void,
  open: (path: string) => Promise<PreparationDocument>, request?: {question: string; wholeDocument: boolean}): Promise<SourceContext> {
  checkCancelled(signal);
  const requested = request && !request.wholeDocument ? requestedPdfPages(request.question) : undefined;
  const document = await open(context.sourcePath);
  try {
    checkCancelled(signal);
    if (!document.readIndexed || !document.sha256) throw new Error('PDF 缓存尚未就绪。');
    if (requested?.some(page => page > document.pageCount)) throw new Error(`PDF 页码超出范围：这份资料共有 ${document.pageCount} 页。`);
    const pages = requested ?? Array.from({length:document.pageCount}, (_, index) => index + 1);
    const result = await document.readIndexed(pages, signal, done => progress(`正在准备 PDF ${requested ? '所问页面' : '全文'}原文 ${done}/${pages.length} 页…`));
    checkCancelled(signal);
    return {...context, selectedText:result.preview, before:'', after:'',
      pdf:{...(requested ? {preparationScope:'question' as const} : {}),indexed:true,sha256:document.sha256,pageCount:document.pageCount,pages,emptyPages:result.emptyPages}};
  } finally { await document.close(); }
}
