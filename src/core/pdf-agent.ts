import type { SourceContext, Usage } from './contracts';

export interface EvidenceImage { data: string; mimeType: 'image/png'; label: string }
export interface PageRegion { x: number; y: number; width: number; height: number }
export interface EvidencePage { page: number; text: string }
export interface EvidenceDocument {
  sha256: string;
  pageCount: number;
  readPages(pages: number[]): Promise<{ pages: EvidencePage[]; emptyPages: number[] }>;
  renderPage(page: number, region?: PageRegion): Promise<EvidenceImage>;
  close(): Promise<void>;
}
export interface PdfEvidencePort { open(path: string): Promise<EvidenceDocument> }
export type EvidenceAction =
  | { action: 'search_document'; query: string; reason: string }
  | { action: 'read_pdf_page'; page: number; reason: string }
  | { action: 'read_page_region'; page: number; region?: PageRegion; reason: string }
  | { action: 'answer'; reason: string; evidenceStatus?: 'sufficient' | 'insufficient' };
export interface EvidenceStep { action: EvidenceAction; result: string; elapsedMs: number }
export interface PdfAgentTrace {
  version: 1;
  sourcePath: string;
  sha256: string;
  scope: number[];
  steps: EvidenceStep[];
  evidencePages: number[];
  imageLabels: string[];
  stop: 'provided' | 'sufficient' | 'insufficient' | 'budget' | 'error' | 'cancelled';
  modelCalls: number;
  elapsedMs: number;
  usage: Usage;
}

export const PDF_AGENT_LIMITS = { tools: 4, images: 2, text: 16_000, decision: 2_000, imageBase64: 4_000_000 } as const;

export function assertImages(images: readonly EvidenceImage[]): void {
  if (images.length > PDF_AGENT_LIMITS.images || images.some(image => image.mimeType !== 'image/png'
    || image.data.length > PDF_AGENT_LIMITS.imageBase64 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(image.data)
    || !image.label || image.label.length > 500)) throw new Error('图片输入无效或超过预算：附件与 PDF 页面图片合计最多 2 张，请减少图片或缩小范围。');
}

export function parseEvidenceAction(text: string, allowLegacyAnswer = false): EvidenceAction {
  if (text.length > PDF_AGENT_LIMITS.decision) throw new Error('证据决策超过输出预算。');
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('证据决策必须是 JSON 对象。');
  const item = value as Record<string, unknown>;
  if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 300) throw new Error('证据决策缺少有效理由。');
  const keys = item.action === 'answer' ? ['action', 'reason', 'evidenceStatus'] : item.action === 'search_document' ? ['action', 'query', 'reason']
    : item.action === 'read_page_region' ? ['action', 'page', 'region', 'reason'] : ['action', 'page', 'reason'];
  if (Object.keys(item).some(key => !keys.includes(key))) throw new Error('证据决策包含未授权参数。');
  if (item.action === 'answer') {
    if (item.evidenceStatus === undefined && allowLegacyAnswer) return { action: item.action, reason: item.reason };
    if (item.evidenceStatus !== 'sufficient' && item.evidenceStatus !== 'insufficient') throw new Error('结束决策必须明确证据充分或不足。');
    return { action: item.action, reason: item.reason, evidenceStatus: item.evidenceStatus };
  }
  if (item.action === 'search_document' && typeof item.query === 'string' && item.query.trim() && item.query.length <= 200) {
    return { action: item.action, query: item.query.trim(), reason: item.reason };
  }
  if ((item.action === 'read_pdf_page' || item.action === 'read_page_region') && Number.isInteger(item.page) && (item.page as number) > 0) {
    if (item.action === 'read_pdf_page') return { action: item.action, page: item.page as number, reason: item.reason };
    if (item.region !== undefined && !isPageRegion(item.region)) throw new Error('图表区域必须位于页面内，坐标范围为 0–1。');
    return { action: item.action, page: item.page as number, reason: item.reason, ...(item.region ? { region: item.region as PageRegion } : {}) };
  }
  throw new Error('证据决策包含未知动作或无效参数。');
}

export function isPageRegion(value: unknown): value is PageRegion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as PageRegion;
  return Object.keys(value).length === 4 && [r.x, r.y, r.width, r.height].every(n => typeof n === 'number' && Number.isFinite(n))
    && r.x >= 0 && r.y >= 0 && r.width >= 0.05 && r.height >= 0.05 && r.x + r.width <= 1 && r.y + r.height <= 1;
}

export function pdfPageText(path: string, pages: readonly EvidencePage[]): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return pages.map(({ page, text }) => `### [第 ${page} 页](</${encoded}#page=${page}>)\n\n${text}`).join('\n\n');
}

export function isPdfAgentTrace(value: unknown, context: SourceContext): value is PdfAgentTrace {
  if (!value || typeof value !== 'object') return false;
  const t = value as PdfAgentTrace;
  const count = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  try {
    return t.version === 1 && t.sourcePath === context.sourcePath && /^[a-f0-9]{64}$/.test(t.sha256)
      && context.pdf?.sha256 === t.sha256 && JSON.stringify(t.scope) === JSON.stringify(context.pdf.pages)
      && Array.isArray(t.steps) && t.steps.length <= PDF_AGENT_LIMITS.tools + 1
      && t.steps.every(step => { parseEvidenceAction(JSON.stringify(step.action), true); return typeof step.result === 'string' && step.result.length <= PDF_AGENT_LIMITS.text && count(step.elapsedMs); })
      && Array.isArray(t.evidencePages) && t.evidencePages.every(p => t.scope.includes(p))
      && Array.isArray(t.imageLabels) && t.imageLabels.length <= PDF_AGENT_LIMITS.images && t.imageLabels.every(s => typeof s === 'string' && s.length <= 500)
      && ['provided', 'sufficient', 'insufficient', 'budget', 'error', 'cancelled'].includes(t.stop) && Number.isInteger(t.modelCalls) && t.modelCalls >= 0 && t.modelCalls <= 6
      && count(t.elapsedMs) && !!t.usage && typeof t.usage === 'object'
      && Object.entries(t.usage).every(([k, v]) => k === 'model' ? typeof v === 'string' : count(v));
  } catch { return false; }
}
