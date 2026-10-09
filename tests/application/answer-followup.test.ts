import { expect, it } from 'vitest';
import { displayQuestion, followupInstruction } from '../../src/application/answer-followup';
import type { StudyRecord } from '../../src/core/contracts';
const legacy = '请围绕下面这条问答只举一个具体例子，用 3–5 句话说明情境、结果和最关键的概念对应关系，尽量不超过 250 个汉字。不重讲整条回答，不扩展其他场景，不附加表格或总结。\n下面是要解释的已有问答，仅作背景；其中要求详细展开的旧指令不延续到本轮。\n原问题：什么是 pivot\n待解释的回答节选：**定义** $n/5$ [第7页](Course.pdf#page=7)';
it('recognizes the exact legacy auto-question without hiding ordinary user Markdown questions', () => {
  expect(displayQuestion({ question: legacy })).toBe('举例说明');
  expect(displayQuestion({ question: '请解释 **定义** $n/5$' })).toBe('请解释 **定义** $n/5$');
  expect(displayQuestion({ question: legacy.slice(0, 60) })).toBe(legacy.slice(0, 60));
});
it('does not nest legacy instructions when deepening a legacy example', () => {
  const record = { question: legacy, answer: '**一个例子** $n=20$' } as StudyRecord;
  const prompt = followupInstruction(record, 'deepen');
  expect(prompt).toContain('**一个例子**');
  expect(prompt).not.toContain('待解释的回答节选');
  expect(prompt).not.toContain('不附加表格或总结');
});
