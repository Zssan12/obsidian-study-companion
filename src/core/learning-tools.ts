export type SearchScope = 'off' | 'source' | 'folder' | 'vault';
export interface LearningToolSettings { scope: SearchScope; web: boolean }
export interface VaultDocument { path: string; size: number; mtime: number }
export interface VaultSearchPort {
  list(): VaultDocument[];
  read(path: string): Promise<string>;
}
export type LearningToolName = 'Glob' | 'Grep' | 'Read' | 'WebSearch' | 'WebFetch';
export interface LearningToolStep {
  evidenceId?: string;
  endLine?: number;
  version?: { mtime: number; size: number };
  tool: LearningToolName;
  input: string;
  text: string;
  error?: boolean;
  /** A verified local file read, not a model-generated path. */
  path?: string;
  startLine?: number;
}
export function isLearningToolTrace(value: unknown): value is LearningToolStep[] {
  if (!Array.isArray(value) || value.length > 4) return false;
  let size = 0;
  return value.every(s => {
    if (!s || typeof s !== 'object' || !['Glob', 'Grep', 'Read', 'WebSearch', 'WebFetch'].includes(s.tool)
      || typeof s.input !== 'string' || s.input.length > 500 || typeof s.text !== 'string' || s.text.length > 5000
      || (s.evidenceId !== undefined && (typeof s.evidenceId !== 'string' || !/^S[1-4]$/u.test(s.evidenceId)))
      || (s.endLine !== undefined && (!Number.isInteger(s.endLine) || s.endLine < (s.startLine ?? 1)))
      || (s.version !== undefined && (!s.version || !Number.isFinite(s.version.mtime) || s.version.mtime < 0 || !Number.isFinite(s.version.size) || s.version.size < 0))
      || (s.error !== undefined && typeof s.error !== 'boolean')
      || (s.path !== undefined && (typeof s.path !== 'string' || !isVaultNotePath(s.path)))
      || (s.startLine !== undefined && (!Number.isInteger(s.startLine) || s.startLine < 1))) return false;
    size += s.text.length; return size <= 14000;
  });
}
export function isVaultNotePath(path: string): boolean {
  const parts = path.split('/');
  return !!path && path.length <= 500 && !path.includes('\\') && !path.includes(':')
    && !Array.from(path).some(c => c.charCodeAt(0) < 32) && parts.every(p => !!p && !p.startsWith('.'))
    && !['Study Companion', 'Study Companion Cache'].includes(parts[0]!) && /\.md$/iu.test(path);
}
