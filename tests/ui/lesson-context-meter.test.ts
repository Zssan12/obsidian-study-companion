// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkspaceLeaf } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { CodexBackend } from '../../src/adapters/codex/CodexBackend';
import { StudyController } from '../../src/application/StudyController';
import type { SourceContext, StudyRecord, StudyState } from '../../src/core/contracts';
import { StudyThreadView } from '../../src/ui/study-thread-view';

vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child: T): T { return child; } removeChild<T>(child: T): T { return child; } register() {} registerEvent() {} }
  class ItemView extends Component { contentEl = document.createElement('div'); app = { workspace: { on: vi.fn() } }; }
  return { Component, ItemView, setIcon: vi.fn(), MarkdownRenderer: { render: vi.fn() } };
});

it('syncs selected-topic teaching usage into the composer ring before the answer finishes', async () => {
  const context: SourceContext = { sourcePath: 'Course.pdf', sourceName: 'Course', selectedText: '平均速度是路程与时间的比值。',
    before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, pdf: { pageCount: 1, pages: [1], emptyPages: [] } };
  let state: StudyState = { version: 1, units: [{ id: 'course', sourcePath: context.sourcePath, createdAt: 'now', provider: 'codex',
    lesson: { planId: 'plan', order: [], skipped: [] } }] };
  const records: StudyRecord[] = [{ id: 'plan', unitId: 'course', kind: 'main', conversationId: 'main:course', context,
    createdAt: 'now', state: 'complete', status: 'unresolved', provider: 'codex', question: '生成目录', lesson: { kind: 'plan' },
    answer: '## 1. 平均速度\n页码：1\n目标：理解平均速度。' }];
  const threadId = '11111111-1111-4111-8111-111111111111';
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.stdout.end(); child.emit('close', 0); return true; }) });
  const emit = (event: unknown) => child.stdout.write(JSON.stringify(event) + '\n');
  const notice = (method: string, params: Record<string, unknown>) => emit({ method, params: { threadId, turnId: 'turn1', ...params } });
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const call = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (call.method === 'initialize') emit({ id: call.id, result: {} });
      if (call.method === 'config/read') emit({ id: call.id, result: { config: {} } });
      if (call.method === 'thread/start') emit({ id: call.id, result: { thread: { id: threadId, ephemeral: true }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } });
      if (call.method === 'turn/start') {
        emit({ id: call.id, result: { turn: { id: 'turn1' } } });
        notice('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 90000 },
          last: { inputTokens: 23000, cachedInputTokens: 10000, outputTokens: 2000, totalTokens: 25000 }, modelContextWindow: 100000 } });
        notice('item/agentMessage/delta', { itemId: 'answer', delta: '平均速度是路程与时间的比值。' });
      }
    }
  });
  const backend = new CodexBackend({ cliPath: '/codex' }, {
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    createWorkingDirectory: async () => '/tmp/isolated-study', prepareToolCatalog: async () => '/tmp/isolated-study/catalog.json',
  });
  let id = 0;
  const controller = new StudyController(backend, {
    loadState: async () => structuredClone(state), saveState: async next => { state = structuredClone(next); },
    listRecords: async () => structuredClone(records), createRecord: async record => { records.push(structuredClone(record)); }, updateStatus: async () => {},
  }, () => `record-${++id}`, undefined, () => 'codex');
  await controller.initialize();
  await controller.startStudy(context);
  const view = new StudyThreadView({} as WorkspaceLeaf, controller, () => context, async () => {});
  await view.onOpen();
  try {
    const button = (label: string) => Array.from(view.contentEl.querySelectorAll('button')).find(item => item.textContent === label)!;
    button('1. 平均速度').click();
    expect(controller.snapshot().running).toHaveLength(0);
    button('讲解所选内容单元').click();
    await vi.waitFor(() => expect(controller.snapshot().running[0]?.answer).toContain('平均速度'));
    const meter = view.contentEl.querySelector<HTMLElement>('.study-companion-context-meter')!;
    expect(meter.getAttribute('aria-label')).toContain('25%');
    expect(meter.style.getPropertyValue('--context-ratio')).toBe('25%');
    notice('turn/completed', { turn: { id: 'turn1', status: 'completed' } });
    await vi.waitFor(() => expect(records).toHaveLength(2));
    expect(records[1]).toMatchObject({ state: 'complete', lesson: { kind: 'teach' } });
    expect(meter.getAttribute('aria-label')).toContain('25%');
  } finally { await view.onClose(); await controller.dispose(); }
});
