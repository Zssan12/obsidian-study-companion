import type { AnswerPolicy } from '../core/contracts';
import { withoutAnswerQuoteBlocks, type AnswerQuoteReference } from './selection-followup';
import type { LessonAction } from '../core/lesson';
import { isConversationOnly } from './retrieval-route';
import { isSelfContainedCalculation } from './self-contained-question';

const SOURCE_REQUEST = /(?:资料|课件|讲义|文档|PDF|幻灯片|原文|第\s*\d+\s*页|这一页|这页|图表|图片|截图|公式|作者|文中|文件里|课上|\b(?:pages?|slides?|document|source|notes?|search|read)\b)/iu;
const HISTORY_FOLLOWUP = /^(?:请\s*)?(?:再|刚才|上面|前面|这句|这段|这个|这里|它|为什么|没懂|不懂|换个|举个|举一|简单|详细|展开|解释|那么|所以|也就是说|(?:why|explain|give (?:me )?an example|what do you mean)\b)/iu;
const QUOTED_EXPLANATION = /(?:引用|选中|这句|这段|这部分|这个|刚才|前面|上面|解释|讲解|讲清|推导|举例|没懂|不懂|为什么|什么意思|\b(?:explain|why|example|this|that|quoted|selected)\b)/iu;
const NEW_EVIDENCE_REQUEST = /(?:资料|课件|讲义|文档|PDF|幻灯片|原文|第\s*\d+\s*页|这一页|这页|图表|图片|截图|作者|文中|文件里|课上|查找|查证|核对|核实|验证|出处|依据在哪|来源在哪|搜索|检索|联网|最新|\b(?:pages?|slides?|document|source|notes?|search|read|verify|check|look\s+up|latest)\b)/iu;
const LESSON_COMMAND = /^(?:按主题讲解|生成目录|继续|下一节|下一主题|下一个主题|开始讲解|继续下一节)[。！!？?]*$/u;
export interface AnswerSourceRoute {
  requested: AnswerPolicy;
  effective: AnswerPolicy;
  useNewEvidence: boolean;
}

/** A bounded routing heuristic, not a claim to understand every question. */
export function resolveAnswerSourceRoute(input: {
  policy?: AnswerPolicy; question: string; hasHistory: boolean;
  lesson?: LessonAction; kind: 'main' | 'quick'; hasAttachments?: boolean; attachments?: readonly AnswerQuoteReference[];
}): AnswerSourceRoute {
  const requested = input.policy ?? 'auto';
  if (input.kind === 'quick') return { requested: 'auto', effective: 'auto', useNewEvidence: true };
  if (input.lesson || LESSON_COMMAND.test(input.question.trim())) return { requested, effective: 'auto', useNewEvidence: true };
  if (requested === 'source') return { requested, effective: 'source', useNewEvidence: true };
  if (requested === 'direct') return { requested, effective: 'direct', useNewEvidence: false };
  const hasSourceAttachments = input.attachments ? input.attachments.some(source => !source.answerRecordId) : input.hasAttachments;
  if (hasSourceAttachments) return { requested, effective: 'auto', useNewEvidence: true };
  const question = withoutAnswerQuoteBlocks(input.question, input.attachments).trim();
  const quotedExplanation = input.attachments?.some(source => source.answerRecordId)
    && QUOTED_EXPLANATION.test(question);
  if (isConversationOnly(question) || isSelfContainedCalculation(question) || (input.hasHistory && !NEW_EVIDENCE_REQUEST.test(question)
    && (quotedExplanation || HISTORY_FOLLOWUP.test(question) && !SOURCE_REQUEST.test(question)))) {
    return { requested, effective: 'direct', useNewEvidence: false };
  }
  return { requested, effective: 'auto', useNewEvidence: true };
}

export function needsNewEvidence(input: {
  policy?: AnswerPolicy; question: string; hasHistory: boolean;
  lesson?: LessonAction; hasAttachments?: boolean; attachments?: readonly AnswerQuoteReference[];
}): boolean {
  return resolveAnswerSourceRoute({ ...input, kind: 'main' }).useNewEvidence;
}

export function answerPolicyInstruction(effective: AnswerPolicy): string {
  if (effective === 'source') return '本轮回答依据为“仅依据资料”：仅依据已提供或本轮读取的原文证据回答。历史模型回答和补充知识不等于原文证据。若资料没有说明，直接说“当前资料没有说明”，不要用常识补成资料结论；本轮不使用上文允许的常识补充。';
  if (effective === 'direct') return '本轮不读取或检索新的资料、笔记、PDF 页面或网页。可以使用已有对话和一般知识直接回答；不要声称本轮查阅了资料。额外知识用简短的“补充知识”标明，资料结论只能援引已有原文依据。';
  return '本轮自动判断回答依据：优先使用相关原文与已有对话；资料没有说明时仍可用一般知识回答，并将那部分简短标为“补充知识”。资料部分可简短标为“依据资料”，不要把补充解释冒充原文，不要仅因资料缺失而拒绝一般知识问题。';
}
