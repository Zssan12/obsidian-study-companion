import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CodexBackend, type CodexBackendConfig } from '../../src/adapters/codex/CodexBackend';
import type { BackendEvent, BackendRequest, StudyBackend } from '../../src/core/contracts';

type Call = { id: number; method: string; params: Record<string, unknown> };
function fixture() {
  const processes: ReturnType<typeof processFixture>[] = [];
  const spawn = vi.fn(() => {
    const process = processFixture(processes.length + 1); processes.push(process);
    return process.child as unknown as ChildProcessWithoutNullStreams;
  });
  return { processes, spawn, createWorkingDirectory: vi.fn(async () => '/tmp/study-retained-test'), prepareToolCatalog: vi.fn(async () => '/tmp/study-retained-test/catalog.json') };
}
function processFixture(number: number) {
  const id = `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const calls: Call[] = [];
  let turns = 0;
  const control = { hold: false, fail: false, tool: false, compaction: false };
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { child.stdout.end(); child.emit('close', 0); return true; }),
  });
  const emit = (event: unknown) => child.stdout.write(JSON.stringify(event) + '\n');
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const call = JSON.parse(line) as Call; calls.push(call);
      if (call.method === 'initialize') emit({ id: call.id, result: {} });
      if (call.method === 'config/read') emit({ id: call.id, result: { config: { model: 'cli-default', model_reasoning_effort: 'medium', mcp_servers: { local: { enabled: true } } } } });
      if (call.method === 'thread/start') emit({ id: call.id, result: { thread: { id, ephemeral: true }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' } });
      if (call.method === 'turn/start') {
        const turnId = `turn-${++turns}`;
        const notice = (method: string, params: Record<string, unknown>) => emit({ method, params: { threadId: id, turnId, ...params } });
        emit({ id: call.id, result: { turn: { id: turnId } } });
        if (control.compaction) {
          notice('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
          notice('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
        }
        notice('item/agentMessage/delta', { itemId: 'same-item-each-turn', delta: `answer-${turns}` });
        if (control.hold) continue;
        if (control.tool) { notice('item/started', { item: { type: 'commandExecution' } }); continue; }
        notice('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: turns * 10 } } });
        notice('turn/completed', { turn: { id: turnId, status: control.fail ? 'failed' : 'completed', error: control.fail ? { message: 'failure' } : undefined } });
      }
    }
  });
  return { id, calls, control, child, emit };
}
async function collect(backend: StudyBackend, request: Partial<BackendRequest> = {}): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of backend.run({ requestId: 'test', prompt: 'current question', retainSession: true, signal: new AbortController().signal, ...request })) events.push(event);
  return events;
}

describe('ephemeral retained Codex sessions', () => {
  it.each(['busy', 'idle'] as const)('preserves continuity across legitimate %s compaction notifications', async timing => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    try {
      await collect(backend); const process = f.processes[0]!;
      if (timing === 'idle') {
        for (const method of ['item/started', 'item/completed']) {
          process.emit({ method, params: { threadId: process.id, turnId: 'turn-1', item: { id: 'compact', type: 'contextCompaction' } } });
          expect(backend.hasSession(process.id)).toBe(true);
        }
      } else process.control.compaction = true;
      expect(backend.hasSession(process.id)).toBe(true);
      const second = await collect(backend, { sessionId: process.id });
      expect(second.at(-1)).toMatchObject({ type: 'done' });
      expect(second.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'answer-2' }]);
      process.control.compaction = false;
      const third = await collect(backend, { sessionId: process.id });
      expect(third.at(-1)).toMatchObject({ type: 'done' });
      expect(f.spawn).toHaveBeenCalledOnce();
      expect(process.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
      expect(process.calls.filter(call => call.method === 'turn/start')).toHaveLength(3);
      expect(process.child.kill).not.toHaveBeenCalled();
      // Recognizing maintenance items must not permit unknown operations.
      process.emit({ method: 'item/started', params: { threadId: process.id,
        item: { id: 'unknown', type: 'unknownFutureTool' } } });
      expect(backend.hasSession(process.id)).toBe(false);
      expect(process.child.kill).toHaveBeenCalledWith('SIGTERM');
    } finally { backend.dispose(); }
  });

  it('starts ephemeral and uses only turn/start for subsequent turns, with fresh deltas and usage', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    try {
      const first = await collect(backend); const process = f.processes[0]!;
      const second = await collect(backend, { sessionId: process.id, prompt: 'only the next question' });
      expect(first.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 10 } });
      expect(second.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: 'answer-2' }]);
      expect(second.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 20 } });
      expect(f.spawn).toHaveBeenCalledOnce();
      expect(process.child.kill).not.toHaveBeenCalled();
      expect(backend.hasSession(process.id)).toBe(true);
      expect(process.calls.filter(call => call.method === 'thread/start')).toHaveLength(1);
      expect(process.calls.find(call => call.method === 'thread/start')!.params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: { 'mcp_servers.local.enabled': false } });
      expect(process.calls.some(call => call.method === 'thread/resume')).toBe(false);
      expect(process.calls.filter(call => call.method === 'turn/start')[1]!.params.input).toEqual([{ type: 'text', text: 'only the next question', text_elements: [] }]);
    } finally { backend.dispose(); }
    expect(f.processes[0]!.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('shares retained sessions across captures while freezing settings and keeping capture disposal local', async () => {
    const f = fixture(); let config: CodexBackendConfig = { cliPath: '/codex', model: 'model-a', effort: 'low' };
    const backend = new CodexBackend(() => config, f);
    const first = backend.capture(); await collect(first); await first.dispose();
    const process = f.processes[0]!;
    expect(first.hasSession?.(process.id)).toBe(false);
    expect(backend.hasSession(process.id)).toBe(true);
    expect(process.child.kill).not.toHaveBeenCalled();
    config = { ...config, model: 'model-b', effort: 'high' };
    const second = backend.capture(); config = { ...config, model: 'model-c', effort: 'low' };
    await collect(second, { sessionId: process.id }); await second.dispose();
    expect(process.calls.filter(call => call.method === 'turn/start')[1]!.params).toMatchObject({ model: 'model-b', effort: 'high' });
    config = { cliPath: '/codex' };
    await collect(backend, { sessionId: process.id });
    expect(process.calls.filter(call => call.method === 'turn/start')[2]!.params).toMatchObject({ model: 'cli-default', effort: 'medium' });
    backend.dispose(); expect(process.child.kill).toHaveBeenCalledOnce();
    expect((await collect(second, { sessionId: process.id }))[0]!.type).toBe('error');
  });

  it('makes helper starts ephemeral and closes them after completion', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    await collect(backend, { retainSession: undefined });
    expect(f.processes[0]!.calls.find(call => call.method === 'thread/start')!.params.ephemeral).toBe(true);
    expect(f.processes[0]!.child.kill).toHaveBeenCalledWith('SIGTERM');
    backend.dispose();
  });

  it('fails before dispatch for lost sessions and rejects retained web calls', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    for (const request of [{ sessionId: '11111111-1111-4111-8111-111111111111' }, { webAccess: true }]) {
      expect((await collect(backend, request))[0]!.type).toBe('error');
    }
    expect(f.spawn).not.toHaveBeenCalled(); backend.dispose();
  });

  it.each(['abort', 'failure', 'tool', 'capture-dispose'] as const)('invalidates a partial turn after %s without retry or disk resume', async reason => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    await collect(backend); const process = f.processes[0]!;
    process.control.hold = reason === 'abort' || reason === 'capture-dispose';
    process.control.fail = reason === 'failure'; process.control.tool = reason === 'tool';
    const capture = backend.capture(); const controller = new AbortController();
    const pending = collect(capture, { sessionId: process.id, signal: controller.signal });
    await vi.waitFor(() => expect(process.calls.filter(call => call.method === 'turn/start')).toHaveLength(2));
    if (reason === 'abort') controller.abort();
    if (reason === 'capture-dispose') await capture.dispose();
    const result = await pending;
    expect(result.some(event => event.type === 'done')).toBe(false);
    expect(process.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(backend.hasSession(process.id)).toBe(false);
    expect((await collect(backend, { sessionId: process.id }))[0]!).toMatchObject({ type: 'error', message: expect.stringContaining('失效') });
    expect(process.calls.filter(call => call.method === 'turn/start')).toHaveLength(2);
    expect(f.spawn).toHaveBeenCalledOnce(); backend.dispose();
  });

  it('rejects concurrent turns without invalidating the running owner', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    await collect(backend); const process = f.processes[0]!; process.control.hold = true;
    const controller = new AbortController(); const pending = collect(backend, { sessionId: process.id, signal: controller.signal });
    await vi.waitFor(() => expect(process.calls.filter(call => call.method === 'turn/start')).toHaveLength(2));
    expect((await collect(backend, { sessionId: process.id }))[0]!).toMatchObject({ type: 'error', message: expect.stringContaining('正在回答') });
    expect(process.child.kill).not.toHaveBeenCalled(); controller.abort(); await pending; backend.dispose();
  });

  it('invalidates idle connections on unexpected server requests', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    await collect(backend); const process = f.processes[0]!;
    process.emit({ id: 'forbidden', method: 'item/commandExecution/requestApproval', params: {} });
    expect(process.child.kill).toHaveBeenCalledOnce();
    expect((await collect(backend, { sessionId: process.id }))[0]!.type).toBe('error');
    expect(process.calls.filter(call => call.method === 'turn/start')).toHaveLength(1); backend.dispose();
  });

  it('does not retain a partially consumed turn when the caller stops reading', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    for await (const event of backend.run({ requestId: 'partial', prompt: 'question', retainSession: true, signal: new AbortController().signal })) {
      if (event.type === 'text') break;
    }
    const process = f.processes[0]!;
    expect(process.child.kill).toHaveBeenCalledOnce();
    expect((await collect(backend, { sessionId: process.id }))[0]!.type).toBe('error'); backend.dispose();
  });

  it('root disposal cancels active captures and invalidates their shared availability', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    await collect(backend); const process = f.processes[0]!;
    const capture = backend.capture(); process.control.hold = true;
    expect(capture.hasSession?.(process.id)).toBe(true);
    const pending = collect(capture, { sessionId: process.id });
    await vi.waitFor(() => expect(process.calls.filter(call => call.method === 'turn/start')).toHaveLength(2));
    backend.dispose(); const events = await pending;
    expect(events.some(event => event.type === 'done')).toBe(false);
    expect(backend.hasSession(process.id)).toBe(false);
    expect(capture.hasSession?.(process.id)).toBe(false);
    expect((await collect(capture))[0]!.type).toBe('error');
    expect(process.child.kill).toHaveBeenCalledOnce(); await capture.dispose();
  });

  it('honors cancellation between yielding session identity and starting the turn', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    const controller = new AbortController();
    for await (const event of backend.run({ requestId: 'cancel-before-turn', prompt: 'question', retainSession: true, signal: controller.signal })) {
      if (event.type === 'session') controller.abort();
    }
    const process = f.processes[0]!;
    expect(process.calls.some(call => call.method === 'turn/start')).toBe(false);
    expect(backend.hasSession(process.id)).toBe(false); backend.dispose();
  });

  it('rejects a policy operation already buffered after turn completion instead of retaining its connection', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    let sessionId = '';
    const events: BackendEvent[] = [];
    for await (const event of backend.run({ requestId: 'queued-policy', prompt: 'question', retainSession: true, signal: new AbortController().signal })) {
      events.push(event);
      if (event.type === 'session') sessionId = event.sessionId;
      if (event.type === 'text') f.processes[0]!.emit({ id: 'late-tool', method: 'item/commandExecution/requestApproval', params: {} });
    }
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('tool operation') });
    expect(backend.hasSession(sessionId)).toBe(false); backend.dispose();
  });

  it('invalidates a retained session when CLI path changes', async () => {
    const f = fixture(); let config = { cliPath: '/codex' }; const backend = new CodexBackend(() => config, f);
    await collect(backend); const process = f.processes[0]!; config = { cliPath: '/other-codex' };
    expect(backend.hasSession(process.id)).toBe(false);
    expect((await collect(backend, { sessionId: process.id }))[0]!).toMatchObject({ type: 'error', message: expect.stringContaining('路径已改变') });
    expect(process.child.kill).toHaveBeenCalledOnce(); expect(f.spawn).toHaveBeenCalledOnce(); backend.dispose();
  });

  it('evicts only the oldest idle connection beyond eight, then fails explicitly for its stale ID', async () => {
    const f = fixture(); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    for (let i = 0; i < 9; i++) await collect(backend);
    expect(f.processes[0]!.child.kill).toHaveBeenCalledOnce();
    expect(backend.hasSession(f.processes[0]!.id)).toBe(false);
    expect(backend.hasSession(f.processes[1]!.id)).toBe(true);
    expect(f.processes.slice(1).every(process => process.child.kill.mock.calls.length === 0)).toBe(true);
    expect((await collect(backend, { sessionId: f.processes[0]!.id }))[0]!.type).toBe('error');
    expect(f.spawn).toHaveBeenCalledTimes(9); backend.dispose();
    expect(f.processes.every(process => process.child.kill.mock.calls.length === 1)).toBe(true);
    expect(f.processes.every(process => !backend.hasSession(process.id))).toBe(true);
  });
});
