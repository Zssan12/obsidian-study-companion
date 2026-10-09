import { expect, it } from 'vitest';
import { checkLearningCitations, learningEvidence } from '../../src/application/learning-citations';
import { retrievalRoute } from '../../src/application/retrieval-route';
import type { LearningToolStep } from '../../src/core/learning-tools';
const trace: LearningToolStep[] = [{ tool: 'Read', path: '课程/上下文.md', input: '课程/上下文.md', startLine: 5, endLine: 7,
  text: '5: ## 缓存规则\n6: 稳定内容在前\n7: 检索在后' }];
it('resolves only this request evidence IDs into links with real line ranges', () => {
  expect(learningEvidence(trace)[0]?.evidenceId).toBe('S1');
  const result = checkLearningCitations('稳定内容在前 [S1]。未知结论 [S9]。', trace, []);
  expect(result.invalid).toBe(1);
  expect(result.answer).toContain('L5–L7');
  expect(result.answer).toContain('%E8%AF%BE%E7%A8%8B');
  expect(result.answer).toContain('[S9]（引用未通过校验）');
});
it('rejects invented headings, unread notes and failed read identities', () => {
  const result = checkLearningCitations('[[课程/上下文.md#捏造小节]] [[secret.md]] [名字](secret.md) <a href="secret.md">秘密</a> [S2]',
    [...trace, { ...trace[0]!, error: true }], []);
  expect(result.invalid).toBe(5);
  expect(result.answer).not.toContain('href=');
});
it('accepts only headings actually visible in evidence, preserves code and web URLs', () => {
  const answer = '[[课程/上下文.md#缓存规则]] `[[unknown.md]] [S9]`\n```md\n[S8]\n```\n[网站](https://example.com)';
  expect(checkLearningCitations(answer, trace, [])).toEqual({ answer, invalid: 0 });
});
it('does not reuse stale S1 from a previous request', () => {
  expect(checkLearningCitations('[S1]', [], []).invalid).toBe(1);
});
it.each(['讲解下这个的意思', '这是什么道理', '什么是缓存？', '讲解一下', '解释一下', '请讲解一下。', '解释这句话', '这句话是什么意思？', '请再举一个例子', '请解释当前选中的内容。'])('skips planner for a bounded selection-only question: %s', question => {
  expect(retrievalRoute({ question, context: '明确选区', sourcePath: 'a.md', settings: { scope: 'folder', web: true } }).retrieve).toBe(false);
});
it.each(['解释这句话，并搜索最新研究', '查找同文件夹的笔记', '这句话是什么意思？也帮我找其他资料'])('retains planning for open or mixed intent: %s', question => {
  expect(retrievalRoute({ question, context: '选区', sourcePath: 'a.md', settings: { scope: 'folder', web: true } }).retrieve).toBe(true);
});
it('does not skip retrieval on empty selection and honors explicit action intent without keyword guessing', () => {
  const input = { question: '解释这句话', context: '', sourcePath: 'a.md', settings: { scope: 'folder' as const, web: true } };
  expect(retrievalRoute(input).retrieve).toBe(true);
  expect(retrievalRoute({ ...input, intent: 'example' }).reason).toBe('explicit-learning-action');
});

it('does not suggest an example evidence ID when no original passage was read', async () => {
  const { learningEvidencePrompt } = await import('../../src/application/learning-citations');
  expect(learningEvidencePrompt([])).toBe('');
  const prompt = learningEvidencePrompt([{ tool: 'Grep', input: 'missing', text: '{"hits":[]}' }]);
  expect(prompt).not.toContain('S1');
  expect(prompt).toContain('仍可基于用户已提供的选区回答');
});

it('validates reference-style local link definitions as well as inline links', () => {
  const result = checkLearningCitations('[引用][note]\n\n[note]: secret.md\n[web]: https://example.com', trace, []);
  expect(result.invalid).toBe(1);
  expect(result.answer).not.toContain('[note]: secret.md');
  expect(result.answer).toContain('[web]: https://example.com');
});

it.each(['source', 'folder', 'vault'] as const)('treats %s as a permission boundary, not a request to search for an existing quote', scope => {
  for (const question of ['讲解下这个的意思', '看不懂，用生活中的例子说明', '这个和上一轮有什么区别', '给出完整推导', 'why does this work?']) {
    expect(retrievalRoute({ question, context: '在多步环境交互中，用奖励优化可训练的决策策略。', sourcePath: 'Agentic RL.md', settings: { scope, web: true } }))
      .toMatchObject({ retrieve: false, reason: 'selection-only' });
  }
  expect(retrievalRoute({ question: '查找同文件夹的笔记，补充其他例子', context: '选区', sourcePath: 'A.md', settings: { scope, web: true } }).retrieve).toBe(true);
});

it('bypasses planning for social turns without a selection but retains mixed source requests', () => {
  for (const scope of ['source', 'folder', 'vault'] as const) {
    for (const question of ['你好', '谢谢！', 'hello', '明白了', 'OK']) {
      expect(retrievalRoute({ question, context: '', sourcePath: 'a.md', settings: { scope, web: true } }))
        .toMatchObject({ retrieve: false, web: false, reason: 'conversation-only' });
    }
    for (const question of ['你好，帮我查找其他笔记', '谢谢，再搜一下最新研究', '解释本文的定理']) {
      expect(retrievalRoute({ question, context: '', sourcePath: 'a.md', settings: { scope, web: true } }).retrieve).toBe(true);
    }
  }
});
