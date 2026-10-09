import type { LearningToolSettings } from '../core/learning-tools';
import { mayUseWeb, type PreviousExchange } from './web-search-policy';
export type RetrievalIntent = 'explain-selection' | 'explain-again' | 'example';
export interface RetrievalRoute { retrieve: boolean; web: boolean; reason: 'disabled' | 'explicit-learning-action' | 'selection-only' | 'conversation-only' | 'planner' }
/** A selection is already chosen evidence. Scope grants access; it does not request a search. */
export function retrievalRoute(input: { intent?: RetrievalIntent; question: string; context: string; sourcePath: string; settings: LearningToolSettings; previous?: PreviousExchange }): RetrievalRoute {
  const web = input.settings.web && mayUseWeb(input.question, input.previous);
  if (!web && (input.settings.scope === 'off'
    || input.settings.scope === 'source' && !/\.md$/iu.test(input.sourcePath)
    || input.settings.scope === 'folder' && !input.sourcePath)) return { retrieve: false, web: false, reason: 'disabled' };
  if (isConversationOnly(input.question)) return { retrieve: false, web: false, reason: 'conversation-only' };
  if (input.intent) return { retrieve: false, web: false, reason: 'explicit-learning-action' };
  if (input.context.trim() && !web && !requestsNoteLookup(input.question)) {
    return { retrieve: false, web: false, reason: 'selection-only' };
  }
  return { retrieve: true, web, reason: 'planner' };
}

function requestsNoteLookup(question: string): boolean {
  if (/(?:只|仅)(?:根据|用|看).{0,12}(?:选区|这段|片段)|(?:不要|不用|别|无需).{0,8}(?:检索|搜索|查找|查笔记)/u.test(question)) return false;
  return /(?:查找|搜索|检索|查|找|读取|阅读|读|结合|对照).{0,40}(?:笔记|文件|同文件夹|笔记库|原文|全文|其他资料|其它资料|其他段落|其它段落)/u.test(question)
    || /(?:哪份|哪篇|哪一节|哪个文件|哪条笔记|同文件夹里|笔记库里)/u.test(question)
    || /\b(?:find|search|read|look\s+up|compare)\b.{0,60}\b(?:notes?|files?|folder|vault|passages?|source\s+text)\b/iu.test(question)
    || /(?:读取|打开|read|open).{0,80}\.md\b/iu.test(question);
}

/** Only self-contained social turns bypass source planning; mixed requests remain eligible. */
export function isConversationOnly(question: string): boolean {
  return /^(?:你好(?:呀|啊|，?助手)?|您好|嗨|哈喽|早上好|晚上好|谢谢(?:你)?|多谢|好的|好|收到|明白了|懂了|再见|hello|hi|hey|thanks|thank you|ok(?:ay)?|got it|bye)[！!。.,，？?\s]*$/iu.test(question.trim());
}
