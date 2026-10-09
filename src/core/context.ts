export interface ContextCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}
export interface DocumentPage { page: number; text: string; ocr?: { text: string; confidence: number; configuration: string } }
export interface DocumentLibrary {
  read(sha256: string, pages: readonly number[], signal: AbortSignal): Promise<DocumentPage[]>;
}
