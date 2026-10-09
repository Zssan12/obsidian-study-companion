import { expect, it } from 'vitest';
import { buildPrompt } from '../../src/application/prompts';
import { emptySourceContext } from '../../src/application/composer-context';
import { answerPolicyInstruction, needsNewEvidence, resolveAnswerSourceRoute } from '../../src/application/answer-policy';

const answerQuote = { ...emptySourceContext('Course.pdf', 'Course'), answerRecordId: 'answer', selectedText: '递推公式' };

it.each(['2+2', '2 + 2 = 4 对吗？', '请计算 (12.5 - 2) / 3，只回复结果。',
  'What is 8 × (3 + 2)?', '计算 15% * 200', 'Reply with only the result: 3+3.'])('skips new PDF/Markdown evidence for closed arithmetic: %s', question => {
  expect(needsNewEvidence({ policy: 'auto', question, hasHistory: false })).toBe(false);
  expect(needsNewEvidence({ policy: 'auto', question, hasHistory: true })).toBe(false);
});

it.each(['课件中2+2为什么等于4？', '查原文核对2+2', '2+2，并搜索最新研究',
  'Calculate the value in this chart', '2+x', '计算它的结果', '2026/9/21', '第2页', '2+2 https://example.com'])('keeps ambiguous and source-dependent tasks on the evidence path: %s', question => {
  expect(needsNewEvidence({ policy: 'auto', question, hasHistory: false })).toBe(true);
});

it('does not let arithmetic override source-only mode, attachments, teaching or Quick Ask selection', () => {
  const input = { question: '2+2', hasHistory: false };
  expect(needsNewEvidence({ ...input, policy: 'source' })).toBe(true);
  expect(needsNewEvidence({ ...input, attachments: [emptySourceContext('Course.pdf', 'Course')] })).toBe(true);
  expect(needsNewEvidence({ ...input, lesson: { kind: 'plan' } })).toBe(true);
  expect(resolveAnswerSourceRoute({ ...input, kind: 'quick' }).useNewEvidence).toBe(true);
});

it.each(['请只说出我引用的主题名称，再用一句话说明它与前面讲过的分治法基本框架有什么关系。',
  '这句话是什么意思？', '请把这个公式的推导讲清楚', 'Can you explain this formula?'])('uses existing history for a quoted explanation: %s', question => {
  expect(needsNewEvidence({ policy: 'auto', question, hasHistory: true, attachments: [answerQuote] })).toBe(false);
});

it.each(['请核对原文中这个公式', '查课件第 8 页', '搜索网页核实这句话', '这句话的出处在哪里？', '解释一下，并搜索最新资料',
  'Check the original PDF', 'Look up the latest information'])('still reads evidence for an explicit source request: %s', question => {
  expect(needsNewEvidence({ policy: 'auto', question, hasHistory: true, attachments: [answerQuote] })).toBe(true);
});

it('recognizes polite ordinary history followups without requiring a selected quote', () => {
  expect(needsNewEvidence({ policy: 'auto', question: '请再解释一下刚才的回答', hasHistory: true })).toBe(false);
  expect(needsNewEvidence({ policy: 'auto', question: '这句话是什么意思', hasHistory: true })).toBe(false);
});

it('does not let an answer quote bypass explicit source attachments, source-only, lessons or missing history', () => {
  const input = { question: '这句话是什么意思？', hasHistory: true, attachments: [answerQuote] };
  expect(needsNewEvidence({ ...input, attachments: [answerQuote, { ...answerQuote, answerRecordId: undefined }] })).toBe(true);
  expect(needsNewEvidence({ ...input, policy: 'source' })).toBe(true);
  expect(needsNewEvidence({ ...input, lesson: { kind: 'plan' } })).toBe(true);
  expect(needsNewEvidence({ ...input, hasHistory: false })).toBe(true);
  expect(resolveAnswerSourceRoute({ ...input, kind: 'quick' }).useNewEvidence).toBe(true);
});

it('omits PDF navigation instructions for Markdown conversations', () => {
  for (const mode of ['study', 'normal'] as const) {
    const prompt = buildPrompt({ ...emptySourceContext('A.md', 'A'), selectedText: '学习概念' }, '解释一下', 'main', mode);
    expect(prompt).not.toContain('#page=');
    expect(prompt).not.toContain('pdf.pages');
    expect(prompt).not.toContain('页码未提供');
  }
});

it('keeps answer source selection inside one request and routes auto conservatively', () => {
  expect(needsNewEvidence({ policy: 'direct', question: '解释一下', hasHistory: true })).toBe(false);
  expect(needsNewEvidence({ policy: 'source', question: '解释一下', hasHistory: true })).toBe(true);
  expect(needsNewEvidence({ policy: 'auto', question: '再举一个例子', hasHistory: true })).toBe(false);
  expect(needsNewEvidence({ policy: 'auto', question: '再解释课件第 8 页', hasHistory: true })).toBe(true);
  expect(needsNewEvidence({ policy: 'auto', question: '解释强化学习', hasHistory: false })).toBe(true);
});

it('forces lesson actions to use their topic evidence regardless of the ordinary-answer option', () => {
  expect(resolveAnswerSourceRoute({ policy: 'direct', question: '开始讲解', hasHistory: true, kind: 'main',
    lesson: { kind: 'plan' } })).toMatchObject({ effective: 'auto', useNewEvidence: true });
});

it('gives source-only and direct turns mutually exclusive evidence instructions', () => {
  expect(answerPolicyInstruction('source')).toContain('当前资料没有说明');
  expect(answerPolicyInstruction('source')).not.toContain('一般知识');
  expect(answerPolicyInstruction('direct')).toContain('不读取或检索新的资料');
});

it('keeps page allowlist guidance for a PDF selection or explicit PDF attachment', () => {
  const markdown = { ...emptySourceContext('A.md', 'A'), selectedText: '学习概念' };
  const pdf = { ...emptySourceContext('Slides.pdf', 'Slides'), selectedText: '课件概念', sourcePages: [3] };
  for (const prompt of [buildPrompt(pdf, '解释一下', 'quick'), buildPrompt(markdown, '对照概念', 'main', 'study', [pdf])]) {
    expect(prompt).toContain('只引用已提供的页面');
    expect(prompt).toContain('未提供页码时只链接文件');
    expect(prompt).toContain('也不额外解释没有页码');
    expect(prompt).toContain('"sourcePages":[3]');
  }
});
