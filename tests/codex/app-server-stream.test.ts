import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { CodexBackend } from '../../src/adapters/codex/CodexBackend';
import type { BackendEvent } from '../../src/core/contracts';

const threadId = '11111111-1111-4111-8111-111111111111';
function server() {
  const calls: { id?: number; method: string; params: Record<string, unknown> }[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { child.stdout.end(); child.emit('close', 0); return true; }) });
  const emit = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const call = JSON.parse(line); calls.push(call);
      if (call.method === 'initialize') emit({ id: call.id, result: {} });
      if (call.method === 'config/read') emit({ id: call.id, result: { config: { mcp_servers: { 'test-server': { enabled: true } } } } });
      if (call.method === 'thread/start' || call.method === 'thread/resume') emit({ id: call.id, result: { thread: { id: threadId, ephemeral: true }, model: 'gpt-5.6-sol', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } });
      if (call.method === 'turn/start') { emit({ id: call.id, result: { turn: { id: 'turn1' } } }); emit({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn1', itemId: 'answer', delta: '第一段。' } }); }
    }
  });
  child.stdin.on('finish', () => { child.stdout.end(); child.emit('close', 0); });
  return { calls, emit, child, spawn: vi.fn(() => child as unknown as ChildProcessWithoutNullStreams), createWorkingDirectory: async () => '/tmp/study-stream-test', prepareToolCatalog: async () => '/tmp/study-stream-test/catalog.json' };
}
it('delivers real deltas before turn completion and does not duplicate the final snapshot', async () => {
  const f = server(); const events: BackendEvent[] = [];
  const backend = new CodexBackend({ cliPath: '/codex' }, f);
  const running = (async () => { for await (const e of backend.run({ requestId: 'stream', prompt: 'teach', signal: new AbortController().signal })) events.push(e); })();
  try {
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'text', text: '第一段。' }));
    expect(events.some(e => e.type === 'done')).toBe(false);
    expect(f.spawn.mock.calls[0]?.length).toBeGreaterThan(0);
    const thread = f.calls.find(c => c.method === 'thread/start');
    expect(thread?.params.config).toMatchObject({ 'mcp_servers.test-server.enabled': false });
    f.emit({ method: 'item/completed', params: { threadId, turnId: 'turn1', item: { type: 'agentMessage', id: 'answer', text: '第一段。第二段。' } } });
    f.emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn1', status: 'completed' } } });
    await running;
    expect(events.filter(e => e.type === 'text').map(e => e.text).join('')).toBe('第一段。第二段。');
    expect(events.at(-1)?.type).toBe('done');
  } finally { backend.dispose(); await running; }
});
