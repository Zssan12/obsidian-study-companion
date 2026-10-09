import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktopBuildOptions } from './build-options.mjs';

if (!process.argv.includes('--live')) {
  console.log('Use --live --provider=claude|codex to run real CLI retrieval and web checks with public/synthetic data.');
  process.exit(0);
}
const provider = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1] ?? 'claude';
if (!['claude', 'codex'].includes(provider)) throw new Error('Unsupported provider');
const output = path.resolve('artifacts/learning-tools', new Date().toISOString().replace(/[:.]/g, '-') + '-' + provider);
await mkdir(output, { recursive: true });
await build({ ...desktopBuildOptions, stdin: { contents: [
  "export { LearningTools } from './src/application/LearningTools';",
  "export { ClaudeBackend } from './src/adapters/claude/ClaudeBackend';",
  "export { CodexBackend } from './src/adapters/codex/CodexBackend';",
].join('\n'), resolveDir: process.cwd() }, outfile: path.join(output, 'runtime.cjs') });
const { LearningTools, ClaudeBackend, CodexBackend } = createRequire(import.meta.url)(path.join(output, 'runtime.cjs'));
const backend = provider === 'claude'
  ? new ClaudeBackend({ cliPath: '/opt/homebrew/bin/claude', cwd: output, effort: 'low' })
  : new CodexBackend({ cliPath: '/opt/homebrew/bin/codex', effort: 'low' });
const notes = {
  'course/01 Agent.md': '# Agent\nAgent 通过工具与外部系统交互。',
  'course/02 Context.md': '# 2.2.2 Context Engineering\n目的是让模型获得当前问题需要的证据。\n稳定指令放在前面，动态检索内容放在后面。缓存只帮助减少重复计算。',
  'other/unrelated.md': '# 无关文件\n不应读取。',
};
const tools = new LearningTools({ list: () => Object.entries(notes).map(([p, text]) => ({ path: p, mtime: 1, size: text.length })),
  read: async p => { if (!(p in notes)) throw new Error('Missing file'); return notes[p]; } });
const report = { provider, startedAt: new Date().toISOString(), local: {}, web: {}, fetch: {} };
try {
  try {
    const trace = await tools.prepare({ backend, request: { requestId: 'local-smoke', provider, prompt: '', signal: AbortSignal.timeout(100_000) },
      settings: { scope: 'folder', web: false }, sourcePath: 'course/01 Agent.md', context: notes['course/01 Agent.md'],
      question: '请查找同文件夹里的笔记，指出哪一节讲 Context Engineering 与缓存的区别。必须读取原文。',
      history: '', progress: text => console.log(text), trace: () => {} });
    report.local = { trace, passed: trace.some(s => s.tool === 'Read' && s.path === 'course/02 Context.md' && !s.error) };
  } catch (error) { report.local = { passed: false, error: String(error) }; }
  for (const [kind, prompt] of [
    ['web', '请实际使用联网搜索工具查询 Obsidian 官方帮助中 backlinks 的定义。输出两句话及实际来源完整 URL，不要凭记忆回答。'],
    ['fetch', '请实际使用网页读取工具打开 https://help.obsidian.md/plugins/backlinks ，用一句话说明它介绍什么，并附完整 URL。无法读取时明确说明。'],
  ]) {
    let text = ''; let done = false; const toolEvents = []; let error;
    for await (const event of backend.run({ requestId: kind + '-smoke', provider, prompt, webAccess: true, signal: AbortSignal.timeout(70_000) })) {
      if (event.type === 'web-tool') toolEvents.push(event);
      if (event.type === 'text') text += event.text;
      if (event.type === 'error') error = event.message;
      if (event.type === 'done') done = true;
    }
    report[kind] = { passed: done && toolEvents.length > 0 && text.includes('https://') && !error, toolEvents, text, error };
    console.log(kind, JSON.stringify(report[kind]));
  }
} finally {
  await backend.dispose();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log('Report:', path.join(output, 'report.json'));
if (!report.local.passed || !report.web.passed || !report.fetch.passed) process.exitCode = 1;
