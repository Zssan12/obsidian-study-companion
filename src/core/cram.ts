import type { BackendProvider } from './contracts';
import type { EvidenceImage } from './pdf-agent';

export const CRAM_LIMITS = { files: 20, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, pages: 600 } as const;
export interface CramInput { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
export interface CramPage { page: number; text: string; image?: EvidenceImage; warning?: string }
export interface CramDocument {
  sha256: string;
  pageCount: number;
  notice: string;
  readPage(page: number, signal: AbortSignal): Promise<CramPage>;
  close(): Promise<void>;
}
export interface CramReader { open(input: CramInput, readImages: boolean, signal: AbortSignal): Promise<CramDocument> }
export interface CramOptions { provider: BackendProvider; focus: string; readImages: boolean }
export interface CramEntry { name: string; state: 'complete' | 'partial' | 'error' | 'cancelled' | 'pending'; path?: string; pages: number; total: number; message?: string }
export interface CramProgress { file: number; files: number; name: string; message: string }
export interface CramResult { indexPath: string; entries: CramEntry[]; cancelled: boolean }

export function validateCramInputs(inputs: readonly CramInput[]): void {
  if (!inputs.length || inputs.length > CRAM_LIMITS.files) throw new Error('一次请选择 1–20 份课件。');
  let total = 0;
  for (const input of inputs) {
    if (!/\.pdf$/iu.test(input.name)) throw new Error(`${input.name}：请使用 PDF 版课件；PPT/PPTX 请先导出为 PDF。`);
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > CRAM_LIMITS.fileBytes) throw new Error(`${input.name}：课件为空或超过 32 MB。`);
    total += input.size;
  }
  if (total > CRAM_LIMITS.totalBytes) throw new Error('所选课件总大小不能超过 256 MB，请分次处理。');
}
