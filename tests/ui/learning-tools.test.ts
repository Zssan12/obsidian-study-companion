// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { renderComposerActivity } from '../../src/ui/learning-tool-controls';
import { renderLearningToolTrace } from '../../src/ui/learning-tool-trace';

it('shows only actual request activity without manual switches or stale tool use', () => {
  const root = document.createElement('div');
  renderComposerActivity(root, '正在使用联网搜索', false);
  expect(root.textContent).toBe('正在使用联网搜索');
  expect(root.querySelector('button, select')).toBeNull();
  renderComposerActivity(root, '正在回答', false, [
    { tool: 'WebSearch', input: 'query', text: 'result' },
    { tool: 'Read', input: 'source.md', text: 'failed', error: true },
  ]);
  expect(root.textContent).toContain('已使用：联网搜索');
  expect(root.textContent).not.toContain('同文件夹');
  renderComposerActivity(root, '请求失败', true);
  expect(root.textContent).toBe('请求失败');
  expect(root.classList.contains('is-error')).toBe(true);
  renderComposerActivity(root, '', false);
  expect(root.textContent).toBe('');
  expect(root.classList.contains('is-error')).toBe(false);
});

it('renders bounded, collapsed, safe evidence and retains expansion across unchanged snapshots', () => {
  const root = document.createElement('div'); const open = vi.fn();
  const trace = [{ tool: 'Read' as const, path: 'notes/source.md', input: 'notes/source.md', startLine: 20,
    text: Array.from({ length: 40 }, (_, i) => `${20 + i}: <script>example</script>`).join('\n') }];
  renderLearningToolTrace(root, trace, open);
  const details = root.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(root.querySelectorAll('li')).toHaveLength(15);
  expect(root.querySelector('script')).toBeNull();
  expect(root.textContent).toContain('还剩 25 行');
  details.open = true;
  renderLearningToolTrace(root, trace, open);
  expect(root.querySelector('details')).toBe(details);
  expect(details.open).toBe(true);
  root.querySelector('button')!.click();
  expect(open).toHaveBeenCalledWith('notes/source.md');
});

it('distinguishes total call usage from context occupancy and marks missing reports', async () => {
  const { renderRequestMetrics } = await import('../../src/ui/request-metrics');
  const root = document.createElement('div');
  renderRequestMetrics(root, { modelCalls: 3, reportedCalls: 1, inputReportedCalls: 1, outputReportedCalls: 0,
    inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, elapsedMs: 1500,
    phases: { preparation: 0, retrieval: 1, web: 1, answer: 1 } });
  expect(root.textContent).toContain('3 次模型调用');
  expect(root.textContent).toContain('1/3 次上报');
  expect(root.textContent).toContain('输出 tokens：未知');
  expect(root.textContent).toContain('不是上下文占用');
});

it('renders stored search hits as grouped note names and line excerpts, never JSON', () => {
  const root = document.createElement('div'); const open = vi.fn();
  const trace = [{ tool: 'Grep' as const, input: 'Agentic RL', text: JSON.stringify({ hits: [
    { path: 'course/Agentic RL.md', line: 15, text: '用奖励优化决策策略。', score: 4 },
    { path: 'course/Agentic RL.md', line: 30, text: '<script>untrusted</script>', score: 3 },
    { path: 'Other.md', line: 4, text: '另一个匹配。', score: 1 },
  ], scanned: 5, totalFiles: 5, incomplete: false }) }];
  renderLearningToolTrace(root, trace, open);
  expect(root.textContent).toContain('2 篇笔记 · 3 处匹配');
  expect(root.textContent).toContain('第 15 行');
  expect(root.textContent).toContain('用奖励优化决策策略。');
  expect(root.textContent).not.toMatch(/"hits"|"score"|"path"/u);
  expect(root.querySelector('script')).toBeNull();
  root.querySelector<HTMLButtonElement>('[aria-label="打开笔记 course/Agentic RL.md"]')!.click();
  expect(open).toHaveBeenCalledWith('course/Agentic RL.md');
  const details = root.querySelector('details')!; details.open = true;
  renderLearningToolTrace(root, [...trace, { tool: 'Read', input: 'Other.md', path: 'Other.md', text: '1: Original' }], open);
  expect(root.querySelector('details')).toBe(details);
  expect(details.open).toBe(true);
});

it('renders file matches, empty searches and incomplete stored JSON without exposing protocol text', () => {
  const root = document.createElement('div'); const open = vi.fn();
  renderLearningToolTrace(root, [{ tool: 'Glob', input: '*.md', text: JSON.stringify({ files: ['A.md'], remaining: 2 }) }], open);
  expect(root.textContent).toContain('展示 1 篇匹配笔记');
  expect(root.textContent).toContain('还有 2 篇');
  root.querySelector('button')!.click(); expect(open).toHaveBeenCalledWith('A.md');
  renderLearningToolTrace(root, [{ tool: 'Grep', input: 'none', text: '{"hits":[]}' }], open);
  expect(root.textContent).toContain('没有找到匹配内容');
  renderLearningToolTrace(root, [{ tool: 'Grep', input: 'partial', text: '{"hits":[{"path":' }], open);
  expect(root.textContent).toContain('搜索结果不完整');
  expect(root.textContent).not.toContain('"hits"');
  renderLearningToolTrace(root, [{ tool: 'Glob', input: '*', text: '{"files":["../../private.md"]}' }], open);
  expect(root.querySelector('button')).toBeNull();
});
