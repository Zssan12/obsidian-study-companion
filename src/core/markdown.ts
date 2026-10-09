import type { SourceContext } from './contracts';

export const MAX_MARKDOWN_LESSON_TEXT = 60_000;

export function isMarkdownScope(value: unknown): value is NonNullable<SourceContext['markdown']> {
  if (!value || typeof value !== 'object') return false;
  const scope = (value as { scope?: unknown }).scope;
  return scope === 'document' || scope === 'selection';
}

export function isMarkdownLesson(context: SourceContext): boolean {
  return isMarkdownScope(context.markdown) && /\.md$/iu.test(context.sourcePath)
    && !context.pdf && !context.image && !context.answerRecordId;
}

/** Freeze only the requested text; links and embeds do not expand the scope. */
export function markdownLessonContext(context: SourceContext, text: string, scope: 'document' | 'selection'): SourceContext {
  const snapshot: SourceContext = { ...context, markdown: { scope }, selectedText: text, before: '', after: '' };
  if (!isMarkdownLesson(snapshot)) throw new Error('请选择普通 Markdown 笔记。');
  if (!text.trim()) throw new Error('笔记或选区为空，暂无可梳理的正文。');
  if (text.length > MAX_MARKDOWN_LESSON_TEXT) throw new Error('正文超过 60000 字符，请选中需要的部分后使用“梳理选区”；不会截断正文。');
  if (scope === 'document') {
    const lines = text.split('\n');
    snapshot.from = { line: 0, ch: 0 };
    snapshot.to = { line: lines.length - 1, ch: lines.at(-1)!.length };
  }
  return snapshot;
}
