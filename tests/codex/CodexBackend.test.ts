import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { CodexBackend } from '../../src/adapters/codex/CodexBackend';
import type { BackendEvent, BackendRequest } from '../../src/core/contracts';
import { delimiter } from 'node:path';

const sessionId = '11111111-1111-4111-8111-111111111111';
const turnId = 'turn1';
const notice = (method: string, params: Record<string, unknown> = {}) => ({ method, params: { threadId: sessionId, turnId, ...params } });
const text = (delta: string, itemId = 'message') => notice('item/agentMessage/delta', { delta, itemId });
const done = notice('turn/completed', { turn: { id: turnId, status: 'completed' } });
function fixture(events: unknown[] = [done], options: { code?: number; idle?: boolean; thread?: string; policy?: string; configError?: boolean; ephemeral?: boolean | 'missing' } = {}) {
  const calls: { id: number; method: string; params: Record<string, unknown> }[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => { child.stdout.end(); child.emit('close', options.code ?? 0); return true; }) });
  const emit = (event: unknown) => child.stdout.write(typeof event === 'string' ? event + '\n' : JSON.stringify(event) + '\n');
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const call = JSON.parse(line); calls.push(call);
      if (call.method === 'initialize') emit({ id: call.id, result: {} });
      if (call.method === 'config/read') emit(options.configError ? { id: call.id, error: { message: 'cannot read config' } } : { id: call.id, result: { config: { mcp_servers: { local: { enabled: true }, 'with-dash': { enabled: true } } } } });
      if (['thread/start', 'thread/resume'].includes(call.method)) emit({ id: call.id, result: { thread: { id: options.thread ?? sessionId, ...(options.ephemeral === 'missing' ? {} : { ephemeral: options.ephemeral ?? true }) }, sandbox: { type: options.policy ?? 'readOnly' }, approvalPolicy: 'never' } });
      if (call.method === 'turn/start') {
        emit({ id: call.id, result: { turn: { id: turnId } } });
        if (!options.idle) {
          for (const event of events) emit(event);
          child.stdout.end();
          setTimeout(() => child.emit('close', options.code ?? 0), 0);
        }
      }
    }
  });
  const spawn = vi.fn((_command: string, _args: string[], _options: unknown) => child as unknown as ChildProcessWithoutNullStreams);
  return { calls, emit, child, spawn, createWorkingDirectory: vi.fn(async () => '/tmp/isolated-study'), prepareToolCatalog: vi.fn(async () => '/tmp/isolated-study/catalog.json') };
}
async function collect(backend: CodexBackend, request: Partial<BackendRequest> = {}): Promise<BackendEvent[]> {
  const result: BackendEvent[] = [];
  for await (const event of backend.run({ requestId: 'r1', prompt: 'synthetic question', signal: new AbortController().signal, ...request })) result.push(event);
  return result;
}

describe('Codex App Server', () => {
  it('streams text, resumes exactly, deduplicates snapshots and maps per-turn usage', async () => {
    const f = fixture([text('An'), text('swer'), notice('item/completed', { item: { type: 'agentMessage', id: 'message', text: 'Answer' } }), notice('item/completed', { item: { type: 'agentMessage', id: 'message', text: 'Answer' } }), notice('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 1000 }, last: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 } } }), done]);
    expect(await collect(new CodexBackend({ cliPath: '/codex', model: 'gpt-5.6-sol', effort: 'medium' }, f), { sessionId })).toEqual([
      { type: 'session', sessionId }, { type: 'text', text: 'An' }, { type: 'text', text: 'swer' },
      { type: 'runtime', runtime: { contextTokens: undefined, contextWindow: undefined } },
      { type: 'done', usage: { model: 'gpt-5.6-sol', inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 } },
    ]);
    expect(f.calls.find(c => c.method === 'thread/resume')?.params).toMatchObject({ threadId: sessionId, cwd: '/tmp/isolated-study', config: { 'mcp_servers.local.enabled': false, 'mcp_servers.with-dash.enabled': false } });
    expect(f.calls.find(c => c.method === 'turn/start')?.params).toMatchObject({ effort: 'medium', input: [{ type: 'text', text: 'synthetic question', text_elements: [] }] });
    const args = f.spawn.mock.calls[0]![1];
    expect(args.slice(0, 2)).toEqual(['app-server', '--stdio']);
    for (const flag of ['features.shell_tool=false', 'features.view_image=false', 'features.hooks=false', 'features.plugins=false', 'notify=[]', 'project_doc_max_bytes=0']) expect(args).toContain(flag);
    expect(args).not.toContain('synthetic question');
  });

  it.each([
    [25000, 100000, 25000, 100000],
    [0, 100000, 0, 100000],
    [12000, null, 12000, undefined],
    [undefined, 100000, undefined, 100000],
    [-1, 0, undefined, undefined],
    ['25000', '100000', undefined, undefined],
  ])('maps current context %s / %s without cumulative or cached-token inflation', async (tokens, window, contextTokens, contextWindow) => {
    const report = (totalTokens: unknown, modelContextWindow: unknown) => notice('thread/tokenUsage/updated', {
      tokenUsage: { total: { totalTokens: 900000 }, last: { totalTokens, inputTokens: 10000, cachedInputTokens: 9000 }, modelContextWindow },
    });
    const f = fixture([
      report(50000, 100000), report(tokens, window),
      { ...report(99999, 100000), params: { ...report(99999, 100000).params, threadId: 'other' } },
      { ...report(99999, 100000), params: { ...report(99999, 100000).params, turnId: 'other' } }, done,
    ]);
    const events = await collect(new CodexBackend({ cliPath: '/codex' }, f));
    expect(events.filter(event => event.type === 'runtime')).toEqual([
      { type: 'runtime', runtime: { contextTokens: 50000, contextWindow: 100000 } },
      { type: 'runtime', runtime: { contextTokens, contextWindow } },
    ]);
    const last = events.at(-1);
    expect(last?.type).toBe('done');
    if (last?.type === 'done') {
      expect(last.usage?.contextTokens).toBe(contextTokens);
      expect(last.usage?.contextWindow).toBe(contextWindow);
      expect(last.usage?.cacheReadTokens).toBe(9000);
    }
  });

  it('captures settings before asynchronous setup', async () => {
    const f = fixture(); let config = { cliPath: '/codex', model: 'first' };
    f.createWorkingDirectory.mockImplementation(async () => { config = { ...config, model: 'second' }; return '/tmp/isolated'; });
    await collect(new CodexBackend(() => config, f));
    expect(f.spawn.mock.calls[0]![1]).toContain('model="first"');
    expect(f.calls.find(c => c.method === 'thread/start')?.params.model).toBe('first');
  });

  it.each([
    [[notice('error', { error: { message: 'Login required' }, willRetry: false })], '登录认证失败'],
    [[notice('item/started', { item: { type: 'commandExecution' } })], 'tool operation'],
    [[notice('item/started', { item: { type: 'mcpToolCall' } })], 'tool operation'],
    [[notice('item/started', { item: { type: 'fileChange' } })], 'tool operation'],
    [[notice('item/started', { item: { type: 'webSearch' } })], 'tool operation'],
    [[{ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} }], 'tool operation'],
    [[text('before'), notice('item/completed', { item: { type: 'agentMessage', id: 'message', text: 'different' } })], 'inconsistent'],
    [[notice('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'TLS handshake failed sk-synthetic-secret' } } })], 'TLS 连接失败'],
    [[], 'before returning a result'],
    [['invalid json'], 'JSON'],
  ])('fails closed on protocol/tool errors', async (events, message) => {
    const f = fixture(events); const result = await collect(new CodexBackend({ cliPath: '/codex' }, f));
    expect(result.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining(message) });
    expect(JSON.stringify(result)).not.toContain('sk-synthetic-secret');
    expect(f.calls.some(c => c.method === 'command/exec' || c.method === 'account/read')).toBe(false);
  });

  it.each([false, 'missing'] as const)('rejects a fresh thread whose ephemeral policy is %s before model dispatch', async ephemeral => {
    const f = fixture([], { ephemeral }); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    const events = await collect(backend, { retainSession: true });
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('ephemeral') }]);
    expect(f.calls.some(call => call.method === 'turn/start')).toBe(false);
    expect(backend.hasSession(sessionId)).toBe(false);
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'); backend.dispose();
  });

  it('rejects another resumed thread and a relaxed sandbox before model dispatch', async () => {
    for (const options of [{ thread: '22222222-2222-4222-8222-222222222222' }, { policy: 'dangerFullAccess' }, { configError: true }]) {
      const f = fixture([], options);
      const result = await collect(new CodexBackend({ cliPath: '/codex' }, f), { sessionId });
      expect(result.at(-1)?.type).toBe('error');
      expect(f.calls.some(c => c.method === 'turn/start')).toBe(false);
    }
  });

  it('ignores notifications from other threads and turns', async () => {
    const f = fixture([notice('item/agentMessage/delta', { threadId: 'other', itemId: 'x', delta: 'wrong' }), notice('item/agentMessage/delta', { turnId: 'other', itemId: 'x', delta: 'wrong' }), text('right'), done]);
    const result = await collect(new CodexBackend({ cliPath: '/codex' }, f));
    expect(result.filter(e => e.type === 'text')).toEqual([{ type: 'text', text: 'right' }]);
  });

  it('rejects ambiguous session references and web-session reuse without spawning', async () => {
    for (const request of [{ sessionId: 'latest' }, { sessionId, webAccess: true }]) {
      const f = fixture(); expect((await collect(new CodexBackend({ cliPath: '/codex' }, f), request))[0]?.type).toBe('error');
      expect(f.spawn).not.toHaveBeenCalled();
    }
  });

  it('cancels an idle stream, closes the child, and prevents further runs after disposal', async () => {
    const f = fixture([], { idle: true }); const backend = new CodexBackend({ cliPath: '/codex' }, f);
    const controller = new AbortController(); const running = collect(backend, { signal: controller.signal });
    await vi.waitFor(() => expect(f.calls.some(c => c.method === 'turn/start')).toBe(true));
    controller.abort();
    expect((await running).some(e => e.type === 'done')).toBe(false);
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    backend.dispose(); expect((await collect(backend))[0]).toMatchObject({ type: 'error', message: expect.stringContaining('disposed') });
  });

  it('sends image attachments on resume without enabling image/filesystem tools', async () => {
    const f = fixture(); const writeImage = vi.fn(async () => {});
    const result = await collect(new CodexBackend({ cliPath: '/codex' }, { ...f, writeImage }), { sessionId, images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png', label: 'chart.pdf#page=2' }] });
    expect(writeImage).toHaveBeenCalledOnce();
    expect(writeImage.mock.calls[0]).toEqual([expect.stringMatching(/^\/tmp\/isolated-study\/study-image-[a-f0-9-]+\.png$/), expect.any(Uint8Array)]);
    expect(f.calls.find(c => c.method === 'turn/start')?.params.input).toEqual([expect.objectContaining({ text: expect.stringContaining('chart.pdf#page=2') }), { type: 'localImage', path: expect.stringContaining('study-image-') }]);
    expect(result.at(-1)?.type).toBe('done');
  });

  it('allows only bounded web search in isolated web requests', async () => {
    const web = [notice('item/started', { item: { type: 'webSearch' } }), notice('item/completed', { item: { type: 'webSearch', status: 'completed' } })];
    const f = fixture([...web, text('source'), done]);
    const result = await collect(new CodexBackend({ cliPath: '/codex' }, f), { webAccess: true });
    expect(result).toContainEqual({ type: 'web-tool', name: 'WebSearch' });
    expect(f.spawn.mock.calls[0]![1]).toContain('web_search="live"');
    const over = fixture([...Array.from({ length: 5 }, () => web).flat(), done]);
    expect((await collect(new CodexBackend({ cliPath: '/codex' }, over), { webAccess: true })).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('预算') });
  });

  it('passes recoverable reconnect progress without adding application retries', async () => {
    const f = fixture([notice('error', { willRetry: true, error: { message: 'temporary connection failure' } }), text('recovered'), done]);
    const result = await collect(new CodexBackend({ cliPath: '/codex' }, f));
    expect(result.map(e => e.type)).toEqual(['session', 'progress', 'text', 'done']);
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('reports a process failure before the result', async () => {
    const f = fixture([], { code: 2 });
    expect((await collect(new CodexBackend({ cliPath: '/codex' }, f))).at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('code 2') });
  });

  it('preserves transport environment without inheriting credentials or disabling TLS', async () => {
    vi.stubEnv('PATH', '/usr/bin:/bin'); vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7897'); vi.stubEnv('NODE_EXTRA_CA_CERTS', '/tmp/test-ca.pem');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0'); vi.stubEnv('NODE_OPTIONS', '--require /tmp/untrusted.js'); vi.stubEnv('OPENAI_API_KEY', 'synthetic-secret');
    const f = fixture();
    try {
      await collect(new CodexBackend({ cliPath: '/opt/homebrew/bin/codex' }, f));
      const options = f.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
      expect(options.env.PATH?.split(delimiter)[0]).toBe('/opt/homebrew/bin');
      expect(options.env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:7897', NODE_EXTRA_CA_CERTS: '/tmp/test-ca.pem' });
      for (const key of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'OPENAI_API_KEY']) expect(options.env).not.toHaveProperty(key);
    } finally { vi.unstubAllEnvs(); }
  });
});
