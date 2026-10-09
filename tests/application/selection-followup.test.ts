import { expect, it } from 'vitest';
import { prepareSelectionFollowupText, withoutAnswerQuoteBlocks } from '../../src/application/selection-followup';
import { needsNewEvidence } from '../../src/application/answer-policy';

it('prefills an editable explanation and the complete multiline quote without duplicating it', () => {
  const text = prepareSelectionFollowupText('我原来的问题', '第一行\n\n第二行');
  expect(text).toBe('我原来的问题\n\n请结合前面的对话，进一步解释下面这段回答，讲清含义和关键原因：\n\n> 第一行\n> \n> 第二行');
  expect(prepareSelectionFollowupText(text, '第一行\n\n第二行')).toBe(text);
});

it('rejects oversized drafts without silently truncating a selected answer', () => {
  expect(() => prepareSelectionFollowupText('已有问题', '长'.repeat(4000))).toThrow('原草稿未更改');
});

it('does not interpret copied source-related words as new evidence instructions', () => {
  const quote = { answerRecordId: 'answer', selectedText: '课件原文的公式，需要搜索和核对。' };
  const question = prepareSelectionFollowupText('', quote.selectedText);
  expect(needsNewEvidence({ question, hasHistory: true, attachments: [quote] })).toBe(false);
  expect(needsNewEvidence({ question: `${question}\n\n请核对课件原文。`, hasHistory: true, attachments: [quote] })).toBe(true);
  expect(withoutAnswerQuoteBlocks(question, [{ ...quote, selectedText: '不同的引用' }])).toBe(question);
  expect(withoutAnswerQuoteBlocks(question, [{ ...quote, answerRecordId: undefined }])).toBe(question);
});
