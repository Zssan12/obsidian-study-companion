import type { AnswerPolicy, ChatMode, SourceContext } from '../core/contracts';
import { validateAttachments } from './prompts';

export interface ComposerDraft { text: string; attachments: SourceContext[]; answerPolicy?: AnswerPolicy; omitContext?: boolean; context?: SourceContext; preparedExplanation?: boolean }
export interface DraftState { version: 1; mode?: ChatMode; entries: Record<string, ComposerDraft> }
export const quickDraftKey = (unitId: string, conversationId: string): string => `quick:${JSON.stringify([unitId, conversationId])}`;

function validQuickKey(key: string): boolean {
  if (!key.startsWith('quick:')) return false;
  try { const ids: unknown = JSON.parse(key.slice(6)); return Array.isArray(ids) && ids.length === 2 && ids.every(id => typeof id === 'string' && id.length > 0); } catch { return false; }
}

const empty = (): ComposerDraft => ({ text: '', attachments: [] });

/** Owns unsent input only; never recreates an answer or sends a request. */
export class ComposerDrafts {
  private entries: Record<string, ComposerDraft> = Object.create(null) as Record<string, ComposerDraft>;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private readonly aliases = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private mode: ChatMode = 'study';
  private readonly submissions = new Set<string>();
  isSubmitting(key: string): boolean { return this.submissions.has(key); }
  constructor(raw?: unknown, private readonly save?: (state: DraftState) => Promise<void>, private readonly onError: (error: unknown) => void = () => {}) {
    if (raw === undefined) return;
    if (!raw || typeof raw !== 'object' || (raw as DraftState).version !== 1 || !(raw as DraftState).entries || typeof (raw as DraftState).entries !== 'object' || Array.isArray((raw as DraftState).entries)) throw new Error('草稿格式无效，原始数据未覆盖。');
    const mode = (raw as DraftState).mode;
    if (mode !== undefined && mode !== 'normal' && mode !== 'study') throw new Error('草稿模式无效，原始数据未覆盖。');
    this.mode = mode ?? 'study';
    for (const [key, value] of Object.entries((raw as DraftState).entries)) {
      if (!key.startsWith('study:') && key !== 'normal' && !validQuickKey(key)) throw new Error('草稿来源格式无效，原始数据未覆盖。');
      if (!value || typeof value.text !== 'string' || !Array.isArray(value.attachments)) throw new Error('草稿内容无效，原始数据未覆盖。');
      if (value.answerPolicy !== undefined && !['auto', 'source', 'direct'].includes(value.answerPolicy)) throw new Error('回答依据无效，原始数据未覆盖。');
      if (value.omitContext !== undefined && typeof value.omitContext !== 'boolean') throw new Error('草稿引用状态无效，原始数据未覆盖。');
      try {
        validateAttachments(value.attachments);
        if (value.preparedExplanation !== undefined && typeof value.preparedExplanation !== 'boolean') throw new Error('Invalid prepared flag');
        if (validQuickKey(key) && !value.context) throw new Error('Missing quick source');
        if (value.context) validateAttachments([value.context]);
        for (const source of [...value.attachments, ...(value.context ? [value.context] : [])]) {
          if (typeof source.sourceName !== 'string' || ![source.from, source.to].every(position => position && Number.isInteger(position.line) && position.line >= 0 && Number.isInteger(position.ch) && position.ch >= 0)) throw new Error('Invalid position');
        }
      } catch { throw new Error('草稿附件格式无效，原始数据未覆盖。'); }
      this.entries[key] = structuredClone(value);
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getMode(): ChatMode { return this.mode; }
  setMode(mode: ChatMode): void { if (this.mode !== mode) { this.mode = mode; this.schedule(); } }
  private notify(): void { for (const listener of this.listeners) { try { listener(); } catch { /* A closing view must not interrupt persistence. */ } } }
  get(key: string): ComposerDraft { return structuredClone(this.entries[this.aliases.get(key) ?? key] ?? empty()); }
  put(key: string, draft: ComposerDraft): void {
    key = this.aliases.get(key) ?? key;
    if (JSON.stringify(this.get(key)) === JSON.stringify(draft)) return;
    if (!draft.text && !draft.attachments.length && !draft.omitContext && !draft.answerPolicy) delete this.entries[key];
    else this.entries[key] = structuredClone(draft);
    this.schedule();
    this.notify();
  }
  clearIfUnchanged(key: string, sent: ComposerDraft): boolean {
    if (JSON.stringify(this.get(key)) !== JSON.stringify(sent)) return false;
    this.put(key, { ...empty(), ...(sent.answerPolicy ? { answerPolicy: sent.answerPolicy } : {}), ...(sent.omitContext ? { omitContext: true } : {}) });
    return true;
  }
  /** Remove submitted input now; restore a failed send only if no newer edit exists. */
  beginSubmission(key: string, sent: ComposerDraft): (success: boolean) => void {
    if (JSON.stringify(this.get(key)) !== JSON.stringify(sent)) return () => {};
    this.submissions.add(key);
    this.put(key, { ...sent, text: '', attachments: [], preparedExplanation: false });
    const cleared = JSON.stringify(this.get(key));
    let changed = false;
    let finished = false;
    const unsubscribe = this.subscribe(() => { if (JSON.stringify(this.get(key)) !== cleared) changed = true; });
    return success => {
      if (finished) return;
      finished = true;
      this.submissions.delete(key);
      unsubscribe();
      if (!success && !changed && JSON.stringify(this.get(key)) === cleared) this.put(key, sent);
    };
  }
  renameSource(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    const oldKey = `study:${oldPath}`; const newKey = `study:${newPath}`;
    if (this.entries[oldKey] && this.entries[newKey]) throw new Error('重命名目标已有草稿，两个草稿均保留，未覆盖。');
    if (this.entries[oldKey]) { this.entries[newKey] = this.entries[oldKey]; delete this.entries[oldKey]; }
    this.aliases.delete(newKey);
    for (const [alias, target] of this.aliases) if (target === oldKey) this.aliases.set(alias, newKey);
    this.aliases.set(oldKey, newKey);
    for (const draft of Object.values(this.entries)) for (const source of [...draft.attachments, ...(draft.context ? [draft.context] : [])]) {
      if (source.sourcePath === oldPath) {
        source.sourcePath = newPath;
        source.sourceName = (newPath.split('/').at(-1) ?? newPath).replace(/\.(md|pdf)$/i, '');
      }
    }
    this.schedule();
    this.notify();
  }
  private schedule(): void {
    if (!this.save) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 300);
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.save) return this.queue;
    const state: DraftState = { version: 1, mode: this.mode, entries: structuredClone(this.entries) };
    const task = this.queue.then(() => this.save!(state)).catch(error => { this.onError(error); throw error; });
    this.queue = task.catch(() => {});
    return task;
  }
}
