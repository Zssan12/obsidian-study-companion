import type {
  QuestionKind,
  RunningQuestion,
  SourceContext,
  StudyRecord,
  StudySnapshot,
  StudyUnit,
} from '../core/contracts';

export interface RecordFilter {
  unitId?: string;
  kind?: QuestionKind | 'all';
  conversationId?: string | 'all';
}

/**
 * Return records that belong to the requested UI scope. Keeping this pure is
 * useful because a snapshot can contain records from every source and popup.
 */
export function filterRecords(records: readonly StudyRecord[], filter: RecordFilter = {}): StudyRecord[] {
  return records.filter((record) => {
    if (filter.unitId && record.unitId !== filter.unitId) return false;
    if (filter.kind && filter.kind !== 'all' && record.kind !== filter.kind) return false;
    if (filter.conversationId && filter.conversationId !== 'all' && record.conversationId !== filter.conversationId) return false;
    return true;
  });
}

export function filterRunning(running: readonly RunningQuestion[], filter: RecordFilter = {}): RunningQuestion[] {
  return running.filter((request) => {
    if (filter.unitId && request.unitId !== filter.unitId) return false;
    if (filter.kind && filter.kind !== 'all' && request.kind !== filter.kind) return false;
    if (filter.conversationId && filter.conversationId !== 'all' && request.conversationId !== filter.conversationId) return false;
    return true;
  });
}

export function findUnit(snapshot: StudySnapshot, unitId?: string): StudyUnit | undefined {
  const id = unitId ?? snapshot.activeUnitId;
  return id ? snapshot.units.find((unit) => unit.id === id) : undefined;
}

export function mainConversationId(unitId: string): string {
  return `main:${unitId}`;
}

export function cloneSourceContext(context: SourceContext): SourceContext {
  return {
    ...(context.markdown ? { markdown: { ...context.markdown } } : {}),
    ...(context.answerRecordId ? { answerRecordId: context.answerRecordId } : {}),
    ...(context.sourcePages ? { sourcePages: [...context.sourcePages] } : {}),
    ...(context.pdf ? { pdf: structuredClone(context.pdf) } : {}),
    sourcePath: context.sourcePath,
    sourceName: context.sourceName,
    selectedText: context.selectedText,
    before: context.before,
    after: context.after,
    from: { line: context.from.line, ch: context.from.ch },
    to: { line: context.to.line, ch: context.to.ch },
  };
}

export function getContextExcerpt(context: SourceContext, maxChars = 2_400): string {
  const body = context.selectedText || [context.before, context.after].filter(Boolean).join('\n');
  if (body.length <= maxChars) return body;
  const side = Math.max(8, Math.floor((maxChars - 1) / 2));
  return `${body.slice(0, side).trimEnd()}…${body.slice(-side).trimStart()}`;
}

export function createConversationId(prefix: 'quick' | 'main', entropy = randomEntropy()): string {
  return `${prefix}:${entropy}`;
}

function randomEntropy(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
