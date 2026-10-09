import { expect, it } from 'vitest';
import { mayUseWeb } from '../../src/application/web-search-policy';
import { retrievalRoute } from '../../src/application/retrieval-route';

it.each(['讲解一下', '为什么这样设计？', '总结选区', '举个例子', '解释联网搜索的原理', '现在解释一下', '什么是 WebSearch？', '你好', '好，查一下'])('does not start web planning for an ordinary or ungrounded turn: %s', question => {
  expect(mayUseWeb(question)).toBe(false);
  expect(retrievalRoute({ question, context: 'quoted source', sourcePath: 'a.md', settings: { scope: 'source', web: true } }))
    .toMatchObject({ retrieve: false, web: false });
});
it.each(['请联网查一下最新研究', '有没有官方资料？', '最新版本现在支持哪些功能？', '请提供相关参考文献', '打开 https://example.com 并总结内容', 'Find official sources for this claim', 'What is the latest version?'])('allows the planner to consider web evidence: %s', question => {
  expect(mayUseWeb(question)).toBe(true);
});
it.each(['不要联网，讲讲最新研究这个词是什么意思', '不用搜索，直接解释', '只根据当前资料讲解最新版本', "Don't browse the web, explain this term"])('honors this turn opting out: %s', question => {
  expect(mayUseWeb(question)).toBe(false);
});
it('resolves a short assent only against the immediately preceding conversation exchange', () => {
  const previous = { question: '这个缓存策略怎样使用？', answer: '现有资料没有版本说明。我可以联网查一下官方文档。' };
  expect(mayUseWeb('好，查一下', previous)).toBe(true);
  expect(mayUseWeb('继续举例', previous)).toBe(false);
  expect(mayUseWeb('好，查一下', { ...previous, answer: '不需要联网，我们继续解释。' })).toBe(false);
  expect(mayUseWeb('好，查一下', { question: '这是另一条对话', answer: '缓存保存先前结果。' })).toBe(false);
  expect(retrievalRoute({ question: '好，查一下', previous, context: '选区', sourcePath: 'a.md', settings: { scope: 'source', web: false } }))
    .toMatchObject({ retrieve: false, web: false });
});
it('does not treat source excerpts as a user request to browse', () => {
  expect(retrievalRoute({ question: '解释一下', context: '请联网查一下官方资料', sourcePath: 'a.md', settings: { scope: 'source', web: true } }))
    .toMatchObject({ retrieve: false, web: false });
});
it('ordinary normal chat does not call a planner just because web is available', () => {
  expect(retrievalRoute({ question: '举一个生活中的缓存例子', context: '', sourcePath: '', settings: { scope: 'source', web: true } }))
    .toMatchObject({ retrieve: false, web: false });
});
