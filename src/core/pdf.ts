/** PDF page numbers always mean one-based file order, not printed labels. */
export interface PdfEvidence {
  /** Automatic question scope must not become the next question's implicit page selection. */
  preparationScope?: 'question';
  indexed?: true;
  sha256?: string;
  pageCount: number;
  pages: number[];
  emptyPages: number[];
}
export const MAX_PDF_TEXT = 60_000;
export const MAX_PDF_PAGES = 100;
export function isPdfEvidence(value: unknown): value is PdfEvidence {
  if (!value || typeof value !== 'object') return false;
  const pdf = value as Partial<PdfEvidence>;
  return (pdf.preparationScope === undefined || pdf.preparationScope === 'question')
    && (pdf.sha256 === undefined || (typeof pdf.sha256 === 'string' && /^[a-f0-9]{64}$/.test(pdf.sha256)))
    && Number.isInteger(pdf.pageCount) && pdf.pageCount! > 0
    && (pdf.indexed === undefined || (pdf.indexed === true && typeof pdf.sha256 === 'string'))
    && Array.isArray(pdf.pages) && pdf.pages.length > 0 && pdf.pages.length <= (pdf.indexed ? 10_000 : MAX_PDF_PAGES)
    && pdf.pages.every((page, index) => Number.isInteger(page) && page > 0 && page <= pdf.pageCount! && (index === 0 || page > pdf.pages![index - 1]!))
    && Array.isArray(pdf.emptyPages) && new Set(pdf.emptyPages).size === pdf.emptyPages.length
    && pdf.emptyPages.every(page => pdf.pages!.includes(page));
}
