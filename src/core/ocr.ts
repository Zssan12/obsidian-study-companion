import type { EvidenceImage } from './pdf-agent';

export interface OcrText { text: string; confidence: number }
export interface LocalOcrPort {
  readonly configuration: string;
  recognize(image: EvidenceImage, signal: AbortSignal): Promise<OcrText>;
}

export function isOcrText(value: unknown): value is OcrText {
  if (!value || typeof value !== 'object') return false;
  const item = value as OcrText;
  return typeof item.text === 'string' && item.text.length <= 60_000
    && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 100;
}
