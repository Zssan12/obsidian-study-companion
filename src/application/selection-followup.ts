import type { SourceContext } from '../core/contracts';
import { MAX_QUESTION_LENGTH } from './prompts';

export type AnswerQuoteReference = Pick<SourceContext, 'answerRecordId'> & Partial<Pick<SourceContext, 'selectedText'>>;

export function answerQuoteBlock(text: string): string {
  return text.trim().split(/\r?\n/u).map(line => `> ${line}`).join('\n');
}

export function prepareSelectionFollowupText(existing: string, selection: string): string {
  const quote = answerQuoteBlock(selection);
  if (existing.split('\n\n').includes(quote)) return existing;
  const prompt = `请结合前面的对话，进一步解释下面这段回答，讲清含义和关键原因：\n\n${quote}`;
  const text = existing.trim() ? `${existing}\n\n${prompt}` : prompt;
  if (text.length > MAX_QUESTION_LENGTH) throw new Error('追问草稿超过 4000 字符，请缩小选区或精简已有问题后重试；原草稿未更改。');
  return text;
}

export function withoutAnswerQuoteBlocks(question: string, attachments: readonly AnswerQuoteReference[] = []): string {
  const quotes = new Set(attachments.filter(source => source.answerRecordId && source.selectedText?.trim())
    .map(source => answerQuoteBlock(source.selectedText!)));
  return question.split('\n\n').filter(block => !quotes.has(block)).join('\n\n');
}
