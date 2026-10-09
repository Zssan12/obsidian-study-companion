import { requestedPdfPages } from './pdf-preparation';
import type { ChatMode, QuestionKind, SourceContext, StudySnapshot } from '../core/contracts';
import type { LessonAction } from '../core/lesson';
import { isConversationOnly } from './retrieval-route';
import { deriveLesson } from './lesson';

export interface PdfQuestionRoute {
  mode: 'none' | 'text' | 'visual';
  message: string;
  blocked?: string;
}

/** One policy for composer previews and dispatch, including non-UI callers. */
export function resolvePdfQuestionRoute(input: {
  enabled: boolean;
  mode: ChatMode;
  kind: QuestionKind;
  context: SourceContext | null;
  attachments?: readonly SourceContext[];
  question?: string;
  lesson?: LessonAction;
  hasLesson?: boolean;
}): PdfQuestionRoute {
  const attachments = input.attachments ?? [];
  if (input.kind === 'main' && !input.lesson && !attachments.length && isConversationOnly(input.question ?? '')) return { mode: 'none', message: '' };
  const sources = [...(input.context ? [input.context] : []), ...attachments].filter(source => source.pdf);
  if (!sources.length) {
    if (input.mode === 'study' && input.kind === 'main' && input.context?.sourcePath.toLowerCase().endsWith('.pdf') && !input.context.selectedText.trim()) {
      try {
        const pages = !input.lesson && !/^(按主题讲解|生成目录)[。！!？?]*$/u.test(input.question?.trim() ?? '') ? requestedPdfPages(input.question ?? '') : undefined;
        return { mode: 'text', message: pages ? `发送后准备第 ${pages.join('、')} 页（文件页序号）；仅以这些页面取证。` : '发送后准备全文原文；可在问题中明确页码以缩小范围。' };
      } catch (error) { const blocked = error instanceof Error ? error.message : '页码无效'; return {mode:'text',message:blocked,blocked}; }
    }
    return { mode: 'none', message: '' };
  }
  const command = input.question?.trim().replace(/[。！!？?]+$/u, '');
  const pageQuestion = input.context?.pdf?.preparationScope === 'question';
  const course = input.kind === 'main' && (input.lesson || input.hasLesson && !pageQuestion || command === '按主题讲解' || command === '生成目录');
  const reason = !input.enabled ? '未开启 PDF 证据问答'
    : input.context?.pdf?.indexed && !pageQuestion && /(全文|全书|整份|整个文档|全部内容|所有章节|概述|总览|summarize|overview)/iu.test(input.question ?? '') ? '全文问题使用分批文字覆盖；无文字页面会列为未覆盖范围'
    : input.mode === 'normal' ? '普通聊天不读取页面图片'
    : course ? '目录讲解仅使用文字，可用独立 PDF Quick Ask 查看图片'
    : !input.context?.pdf ? 'PDF 作为附件时仅提供文字'
    : attachments.length ? '含其他附件时仅提供文字；移除附件后可按需看图' : undefined;
  if (!reason) {
    const blocked = !input.context?.pdf?.sha256 ? '请重新选择 PDF 页码，以固定图文证据的文件版本。' : undefined;
    return { mode: 'visual', message: `本次：图文证据问答 · 按需看图${blocked ? `。${blocked}` : ''}`, ...(blocked ? { blocked } : {}) };
  }
  const scans = sources.filter(source => source.pdf!.pages.length > 0 && source.pdf!.pages.every(page => source.pdf!.emptyPages.includes(page)));
  const blocked = scans.length ? `无法发送：${scans.map(source => source.sourceName).join('、')}的所选页没有可提取文字，当前模式无法看图。请改用无其他附件的学习模式 PDF 证据问答，或重新选择含文字的页面。` : undefined;
  const partial = !blocked && sources.some(source => source.pdf!.emptyPages.length);
  return { mode: 'text', message: `本次：仅文字 · ${reason}。${blocked ?? (partial ? '无文字页面的内容不会提供给模型。' : '')}`, ...(blocked ? { blocked } : {}) };
}

/** A study composer's first explicit PDF is promoted to its primary source on send. */
export function previewMainPdfRoute(snapshot: StudySnapshot, context: SourceContext | null, attachments: readonly SourceContext[],
  enabled: boolean, question: string, lesson?: LessonAction): PdfQuestionRoute {
  const mode = snapshot.mode ?? 'study';
  const pdfIndex = mode === 'study' ? attachments.findIndex(source => source.pdf) : -1;
  const unit = mode === 'study' ? snapshot.units.find(item => item.mode !== 'normal' && item.sourcePath === context?.sourcePath) : undefined;
  return resolvePdfQuestionRoute({ enabled, mode, kind: 'main', context, question, lesson,
    attachments: lesson ? [] : attachments.filter((_, index) => index !== pdfIndex),
    hasLesson: Boolean(unit && context && deriveLesson(unit, snapshot.records, context)),
  });
}
