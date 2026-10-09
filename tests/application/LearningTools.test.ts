import { needsManagedHistory } from '../../src/application/conversation-context';
import { expect, it, vi } from 'vitest';
import { LearningTools } from '../../src/application/LearningTools';
import type { BackendEvent, BackendRequest, StudyBackend, StudyRecord } from '../../src/core/contracts';
import type { LearningToolSettings, LearningToolStep } from '../../src/core/learning-tools';

function fixture(actions: unknown[], notes: Record<string, string> = {
  'course/current.md': 'current material',
  'course/context.md': '# Context Engineering\n稳定提示在前，动态资料在后。\n缓存是排布规则。',
  'elsewhere/private.md': 'other folder',
  '.obsidian/private.md': 'hidden',
  'Study Companion/record.md': 'generated answer',
}) {
  const requests: BackendRequest[] = [];
  const read = vi.fn(async (path: string) => {
    const text = notes[path]; if (text === undefined) throw new Error('removed'); return text;
  });
  const backend: StudyBackend = { async *run(request) {
    requests.push(request);
    const action = actions.shift();
    if (Array.isArray(action)) { for (const event of action) yield event as BackendEvent; }
    else { yield { type: 'text', text: JSON.stringify(action ?? { tool: 'answer' }) }; yield { type: 'done' }; }
  }, dispose() {} };
  const agent = new LearningTools({ list: () => Object.entries(notes).map(([path, text]) => ({ path, size: text.length, mtime: 1 })), read });
  const controller = new AbortController();
  const trace: LearningToolStep[][] = [];
  const progress = vi.fn();
  const run = (settings: LearningToolSettings = { scope: 'folder', web: false }, question = '查找同文件夹笔记，缓存命中和 Context Engineering 有什么关系？') => agent.prepare({
    backend, request: { requestId: 'r', prompt: '', sessionId: 'main-session', signal: controller.signal, provider: 'codex' },
    sourcePath: 'course/current.md', question,
    context: '学习选区', history: '', settings, progress, trace: steps => trace.push(steps),
  });
  return { run, progress, requests, read, notes, controller, trace };
}
it('skips the planner when no authorized files or web tools are available', async () => {
  const f = fixture([], {});
  expect(await f.run()).toEqual([]);
  expect(f.requests).toHaveLength(0);
});

it('reads a complete small source directly without asking a model to select the only file', async () => {
  const f = fixture([], { 'course/current.md': 'A complete definition\nAn important qualification' });
  const steps = await f.run({ scope: 'source', web: false }, '读取原文解释这个概念');
  expect(f.requests).toHaveLength(0);
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ tool: 'Read', path: 'course/current.md', startLine: 1, endLine: 2 });
  expect(steps[0]?.text).toContain('An important qualification');
});

it('searches same-folder evidence and reads a bounded passage in isolated requests', async () => {
  const f = fixture([{ tool: 'Grep', query: '缓存 Context' }, { tool: 'Read', path: 'course/context.md', startLine: 1 }, { tool: 'answer' }]);
  const result = await f.run();
  expect(result[0]?.text).toContain('course/context.md');
  expect(result[1]).toMatchObject({ tool: 'Read', path: 'course/context.md', startLine: 1 });
  expect(result[1]?.text).toContain('稳定提示在前');
  expect(f.requests.every(r => r.sessionId === undefined)).toBe(true);
  expect(f.read.mock.calls.flat()).not.toContain('elsewhere/private.md');
  expect(f.requests[0]?.prompt).not.toContain('.obsidian/private.md');
  expect(f.requests[0]?.prompt).not.toContain('Study Companion/record.md');
});
it.each(['../outside.md', '/etc/passwd', 'elsewhere/private.md', '.obsidian/private.md', 'Study Companion/record.md'])('rejects an unauthorized read: %s', async path => {
  const f = fixture([{ tool: 'Read', path }]);
  expect((await f.run())[0]?.error).toBe(true);
  expect(f.read).not.toHaveBeenCalled();
});
it('refreshes scope metadata when a previously available note is removed', async () => {
  const f = fixture([{ tool: 'Read', path: 'course/context.md' }, { tool: 'answer' }, { tool: 'Read', path: 'course/context.md' }]);
  await f.run(); delete f.notes['course/context.md'];
  const result = await f.run();
  expect(result[0]?.error).toBe(true);
});
it('does not contact the web when disabled, even if the model requests it', async () => {
  const f = fixture([{ tool: 'WebSearch', query: 'latest information' }]);
  expect((await f.run())[0]?.error).toBe(true);
  expect(f.requests.some(r => r.webAccess)).toBe(false);
});
it('requires an actual web tool completion and isolates the web prompt from local context', async () => {
  const f = fixture([{ tool: 'WebSearch', query: 'context engineering cache' },
    [{ type: 'web-tool', name: 'WebSearch' }, { type: 'text', text: 'Source https://example.com/docs' }, { type: 'done' }],
    { tool: 'answer' }]);
  const result = await f.run({ scope: 'folder', web: true }, '请联网查找 Context Engineering 的官方资料');
  expect(f.progress.mock.calls.some(([message]) => message.startsWith('正在使用联网搜索'))).toBe(true);
  const web = f.requests.find(r => r.webAccess)!;
  expect(web.sessionId).toBeUndefined();
  expect(web.prompt).not.toContain('学习选区');
  expect(result[0]?.text).toContain('非网页逐字原文');
});
it('rejects a plausible web answer when no tool ran', async () => {
  const f = fixture([{ tool: 'WebSearch', query: 'query' },
    [{ type: 'text', text: 'A plausible answer https://example.com' }, { type: 'done' }]]);
  expect((await f.run({ scope: 'off', web: true }, '请联网查找公开资料'))[0]?.error).toBe(true);
});
it('does not fetch a model-invented URL', async () => {
  const f = fixture([{ tool: 'WebFetch', query: 'https://invented.example/private' }]);
  expect((await f.run({ scope: 'off', web: true }, '请联网查找公开资料'))[0]?.error).toBe(true);
  expect(f.requests.some(r => r.webAccess)).toBe(false);
});
it('bounds tool count and full-text result size', async () => {
  const f = fixture(Array.from({ length: 12 }, (_, i) => ({ tool: 'Read', path: 'course/context.md', startLine: i + 1 })),
    { 'course/context.md': Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n') });
  const result = await f.run();
  expect(result.length).toBeLessThanOrEqual(4);
  expect(result.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(8000);
});
it('cancels before reading or running a model', async () => {
  const f = fixture([{ tool: 'Read', path: 'course/context.md' }]); f.controller.abort();
  await expect(f.run()).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(0);
});
it('returns a visible trace for malformed planner output without executing a tool', async () => {
  const f = fixture([[{ type: 'text', text: 'not JSON' }, { type: 'done' }]]);
  const steps = await f.run();
  expect(steps[0]?.error).toBe(true); expect(f.read).not.toHaveBeenCalled();
});

it('counts retrieved tool evidence toward long-conversation compaction even when answers are short', () => {
  const records = Array.from({ length: 8 }, () => ({ question: '短问题', answer: '短回答', context: { selectedText: '短选区' },
    toolTrace: [{ tool: 'Read', input: 'a.md', text: 'x'.repeat(4000) }, { tool: 'Read', input: 'b.md', text: 'x'.repeat(4000) }],
  })) as StudyRecord[];
  expect(needsManagedHistory(records, '当前问题')).toBe(true);
  expect(needsManagedHistory(records.map(r => ({ ...r, toolTrace: undefined })), '当前问题')).toBe(false);
});

it('explicit explanation actions skip both the planner and file reads', async () => {
  const requests: BackendRequest[] = [];
  const read = vi.fn(async () => 'source');
  const agent = new LearningTools({ list: () => [], read });
  const backend: StudyBackend = { async *run(r) { requests.push(r); yield { type: 'done' }; }, dispose() {} };
  expect(await agent.prepare({ backend, request: { requestId: 'r', prompt: '', signal: new AbortController().signal },
    settings: { scope: 'vault', web: true }, intent: 'example', sourcePath: 'a.md', question: '复杂的例子要求', context: '', history: '', progress: vi.fn(), trace: vi.fn() })).toEqual([]);
  expect(requests).toHaveLength(0); expect(read).not.toHaveBeenCalled();
});

it('rejects a note edited between scope capture and the actual read', async () => {
  let mtime = 1;
  const agent = new LearningTools({ list: () => [{ path: 'a.md', size: 5, mtime }], read: async () => { mtime = 2; return 'other'; } });
  let called = 0;
  const result = await agent.prepare({ backend: { async *run() { yield { type: 'text', text: JSON.stringify(called++ ? { tool: 'answer' } : { tool: 'Read', path: 'a.md' }) }; yield { type: 'done' }; }, dispose() {} },
    request: { requestId: 'r', prompt: '', signal: new AbortController().signal }, settings: { scope: 'vault', web: false },
    sourcePath: 'a.md', question: '查找原文', context: '', history: '', progress: vi.fn(), trace: vi.fn() });
  expect(result[0]?.error).toBe(true); expect(result[0]?.evidenceId).toBeUndefined();
});

it('source scope searches only the current note and refuses another note in the same folder', async () => {
  const f = fixture([{ tool: 'Grep', query: 'current' }, { tool: 'Read', path: 'course/context.md' }, { tool: 'answer' }]);
  // Web availability keeps this open question on the planner route; local scope must still hold.
  const steps = await f.run({ scope: 'source', web: true }, '请联网核对当前资料的最新研究');
  expect(f.read.mock.calls.flat()).toEqual(['course/current.md']);
  expect(f.requests[0]?.prompt).not.toContain('course/context.md');
  expect(steps[1]?.error).toBe(true);
});

it('source-only selected questions need neither a planner call nor a file scan', async () => {
  const f = fixture([]);
  expect(await f.run({ scope: 'source', web: false }, '缓存命中和 Context Engineering 有什么关系？')).toEqual([]);
  expect(f.requests).toEqual([]);
  expect(f.read).not.toHaveBeenCalled();
});

it('does not let a local planner turn an ordinary question into a web search', async () => {
  const f = fixture([{ tool: 'WebSearch', query: 'cache' }]);
  const steps = await f.run({ scope: 'folder', web: true });
  expect(steps[0]?.error).toBe(true);
  expect(f.requests.some(r => r.webAccess)).toBe(false);
});

it('does not launch another search after the first web research request', async () => {
  const events = [{ type: 'web-tool', name: 'WebSearch' }, { type: 'text', text: 'https://example.com' }, { type: 'done' }];
  const f = fixture([{ tool: 'WebSearch', query: 'cache' }, events, { tool: 'WebSearch', query: 'another cache query' }, events]);
  const steps = await f.run({ scope: 'off', web: true }, '请联网查一下缓存的官方资料');
  expect(f.requests.filter(r => r.webAccess)).toHaveLength(1);
  expect(steps.at(-1)?.error).toBe(true);
});

it.each(['Glob', 'Grep'] as const)('keeps %s results parseable when long file paths exceed the display budget', async tool => {
  const notes = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`course/${'long'.repeat(90)}-${i}.md`, 'cache '.repeat(40)]));
  const f = fixture([{ tool, query: tool === 'Glob' ? '*' : 'cache' }, { tool: 'answer' }], notes);
  const result = await f.run();
  expect(result[0]?.text.length).toBeLessThanOrEqual(4800);
  const parsed = JSON.parse(result[0]!.text);
  expect(tool === 'Glob' ? parsed.remaining : parsed.remainingHits).toBeGreaterThan(0);
  expect(tool === 'Glob' ? parsed.files.length : parsed.hits.length).toBeGreaterThan(0);
});
