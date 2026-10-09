import { TFile, type MarkdownView, type Vault } from 'obsidian';
import type { SourceContext } from '../../core/contracts';
import { markdownLessonContext } from '../../core/markdown';

/** Prefer the matching open editor, including edits not yet flushed to disk. */
export async function prepareMarkdownLesson(context: SourceContext, scope: 'document' | 'selection', signal: AbortSignal,
  vault: Pick<Vault, 'getAbstractFileByPath' | 'read'>, views: readonly (MarkdownView | null | undefined)[]): Promise<SourceContext> {
  if (signal.aborted) throw new Error('已取消梳理。');
  let text = context.selectedText;
  if (scope === 'document') {
    const file = vault.getAbstractFileByPath(context.sourcePath);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') throw new Error('笔记已移动或不存在。');
    const view = views.find(view => view?.file?.path === file.path);
    text = view?.editor ? view.editor.getValue() : await vault.read(file);
  }
  if (signal.aborted) throw new Error('已取消梳理。');
  return markdownLessonContext(context, text, scope);
}
