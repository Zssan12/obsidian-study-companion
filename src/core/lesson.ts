/** Explicit user actions; a normal follow-up never advances lesson progress. */
export type LessonAction = { kind: 'plan' } | { kind: 'teach'; planId: string; topicKey: string; topicKeys?: string[] };

/** User choices only. Topic content and completed explanations live in saved records. */
export interface LessonSettings {
  planId: string;
  order: string[];
  skipped: string[];
}

export interface LessonTopic {
  chapter?: string;
  category?: '课程安排' | '知识内容' | '补充资料';
  key: string;
  title: string;
  pages: number[];
  objective: string;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

export function isLessonAction(value: unknown): value is LessonAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<LessonAction>;
  return action.kind === 'plan' || (action.kind === 'teach' && boundedId(action.planId) && boundedId(action.topicKey)
    && (action.topicKeys === undefined || (Array.isArray(action.topicKeys) && action.topicKeys.length > 0
      && action.topicKeys.length <= 10_000 && action.topicKeys.every(boundedId)
      && new Set(action.topicKeys).size === action.topicKeys.length && action.topicKeys[0] === action.topicKey)));
}

export function isLessonSettings(value: unknown): value is LessonSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Partial<LessonSettings>;
  const keys = (items: unknown): items is string[] => Array.isArray(items) && items.length <= 10_000
    && items.every(boundedId) && new Set(items).size === items.length;
  return boundedId(settings.planId) && keys(settings.order) && keys(settings.skipped)
    && settings.skipped.every(key => settings.order!.includes(key));
}

/** Older single-topic records remain readable without migration. */
export function lessonTopicKeys(action: Extract<LessonAction, { kind: 'teach' }>): string[] {
  return action.topicKeys ?? [action.topicKey];
}
