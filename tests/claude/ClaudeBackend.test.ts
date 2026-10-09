import { describe, expect, it } from 'vitest';

import {
  ClaudeBackend,
  type ClaudeBackendConfig,
  type ClaudeQuery,
  type ClaudeQueryFactory,
  type ClaudeQueryParams,
} from '../../src/adapters/claude/ClaudeBackend';
import type { BackendEvent, BackendRequest } from '../../src/core/contracts';

type TestMessage = ClaudeQuery extends AsyncIterable<infer Message> ? Message : never;

class FakeQuery implements ClaudeQuery {
  closed = false;
  private readonly messages: TestMessage[];
  private readonly holdOpen: boolean;
  private releasePending?: () => void;

  constructor(messages: unknown[] = [], holdOpen = false) {
    this.messages = messages as TestMessage[];
    this.holdOpen = holdOpen;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TestMessage> {
    for (const message of this.messages) yield message;
    if (this.holdOpen) await new Promise<void>((resolve) => {
      this.releasePending = resolve;
    });
  }

  close(): void {
    this.closed = true;
    this.releasePending?.();
  }
}

const config: ClaudeBackendConfig = {
  cliPath: '/opt/homebrew/bin/claude',
  cwd: '/vault',
  model: 'claude-sonnet-test',
};

function makeRequest(
  signal: AbortSignal,
  sessionId?: string,
): BackendRequest {
  return {
    requestId: 'request-1',
    prompt: 'Explain this selection.',
    ...(sessionId ? { sessionId } : {}),
    signal,
  };
}

async function collect(iterable: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function queryFactoryFor(
  query: ClaudeQuery,
  onParams?: (params: ClaudeQueryParams) => void,
): ClaudeQueryFactory {
  return (params) => {
    onParams?.(params);
    return query;
  };
}

describe('ClaudeBackend', () => {
  it('freezes each request configuration and preserves resume when the next request changes model', async () => {
    const current: ClaudeBackendConfig = { ...config, effort: 'low' };
    const calls: ClaudeQueryParams[] = [];
    const backend = new ClaudeBackend(() => current, { query: params => {
      calls.push(params);
      return new FakeQuery([{ type: 'system', subtype: 'init', session_id: 'session-1', model: params.options.model }]);
    } });
    const first = backend.run(makeRequest(new AbortController().signal, 'session-1'))[Symbol.asyncIterator]();
    const pending = first.next();
    current.model = 'opus';
    current.effort = 'max';
    await pending;
    const runtime = await first.next();
    expect(runtime.value).toMatchObject({ type: 'runtime', runtime: { effort: 'low' } });
    await first.return?.();
    await collect(backend.run(makeRequest(new AbortController().signal, 'session-1')));
    expect(calls[0]?.options).toMatchObject({ model: config.model, effort: 'low', resume: 'session-1' });
    expect(calls[1]?.options).toMatchObject({ model: 'opus', effort: 'max', resume: 'session-1' });
    delete current.model;
    delete current.effort;
    await collect(backend.run(makeRequest(new AbortController().signal, 'session-1')));
    expect(calls[2]?.options.model).toBeUndefined();
    expect(calls[2]?.options.effort).toBeUndefined();
  });

  it('passes a read-only SDK policy, streams partial text once, and reports usage', async () => {
    const query = new FakeQuery([
      { type: 'system', subtype: 'init', session_id: 'session-1' },
      {
        type: 'stream_event',
        session_id: 'session-1',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      },
      {
        type: 'stream_event',
        session_id: 'session-1',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      },
      {
        type: 'assistant',
        session_id: 'session-1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'Hello' }] },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        is_error: false,
        result: 'Hello',
        num_turns: 1,
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    ]);
    let captured: ClaudeQueryParams | undefined;
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    const originalSecret = process.env.STUDY_COMPANION_TEST_SECRET;
    process.env.ANTHROPIC_API_KEY = 'must-not-be-forwarded';
    process.env.STUDY_COMPANION_TEST_SECRET = 'must-not-be-forwarded';

    try {
      const backend = new ClaudeBackend(config, {
        query: queryFactoryFor(query, (params) => { captured = params; }),
      });
      const events = await collect(backend.run(makeRequest(new AbortController().signal)));

      expect(events).toEqual([
        { type: 'session', sessionId: 'session-1' },
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'runtime', runtime: { contextTokens: 15 } },
        {
          type: 'done',
          usage: {
            contextTokens: 15,
            inputTokens: 12,
            outputTokens: 8,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
          },
        },
      ]);
      expect(captured?.prompt).toBe('Explain this selection.');
      expect(captured?.options).toMatchObject({
        cwd: '/vault',
        model: 'claude-sonnet-test',
        pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
        includePartialMessages: true,
        maxTurns: 1,
        permissionMode: 'dontAsk',
        systemPrompt: expect.any(String),
        tools: [],
        allowedTools: [],
        mcpServers: {},
        plugins: [],
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
      });
      expect(captured?.options.resume).toBeUndefined();
      expect(captured?.options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(captured?.options.env).not.toHaveProperty('STUDY_COMPANION_TEST_SECRET');
      expect(query.closed).toBe(true);
    } finally {
      if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalApiKey;
      if (originalSecret === undefined) delete process.env.STUDY_COMPANION_TEST_SECRET;
      else process.env.STUDY_COMPANION_TEST_SECRET = originalSecret;
    }
  });

  it('uses only the session ID supplied for the current request', async () => {
    const captured: ClaudeQueryParams[] = [];
    const factory: ClaudeQueryFactory = queryFactoryFor(
      new FakeQuery([{ type: 'result', subtype: 'success', is_error: false, result: '' }]),
      (params) => captured.push(params),
    );
    const backend = new ClaudeBackend(config, { query: factory });

    await collect(backend.run(makeRequest(new AbortController().signal)));
    await collect(backend.run(makeRequest(new AbortController().signal, 'resume-session')));

    expect(captured).toHaveLength(2);
    expect(captured[0]?.options.resume).toBeUndefined();
    expect(captured[1]?.options.resume).toBe('resume-session');
  });

  it('captures a session ID from an error result and preserves its error message', async () => {
    const query = new FakeQuery([
      {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'failed-session',
        errors: ['CLI exited with code 1'],
      },
    ]);
    const backend = new ClaudeBackend(config, {
      query: queryFactoryFor(query),
    });

    await expect(collect(backend.run(makeRequest(new AbortController().signal)))).resolves.toEqual([
      { type: 'session', sessionId: 'failed-session' },
      { type: 'error', message: 'CLI exited with code 1' },
    ]);
  });

  it('surfaces query factory failures without retrying', async () => {
    let attempts = 0;
    const backend = new ClaudeBackend(config, {
      query: () => {
        attempts += 1;
        throw new Error('Claude CLI could not start.');
      },
    });

    await expect(collect(backend.run(makeRequest(new AbortController().signal)))).resolves.toEqual([
      { type: 'error', message: 'Claude CLI could not start.' },
    ]);
    expect(attempts).toBe(1);
  });

  it('reports missing setup from run so a fresh settings view can construct the backend', async () => {
    const backend = new ClaudeBackend({ cliPath: '', cwd: '' }, {
      query: () => new FakeQuery(),
    });

    await expect(collect(backend.run(makeRequest(new AbortController().signal)))).resolves.toEqual([
      { type: 'error', message: '请先在设置中配置 Claude CLI 路径。' },
    ]);
  });

  it('aborts and closes an active query when the request signal is cancelled', async () => {
    const query = new FakeQuery([], true);
    let captured: ClaudeQueryParams | undefined;
    const backend = new ClaudeBackend(config, {
      query: queryFactoryFor(query, (params) => { captured = params; }),
    });
    const controller = new AbortController();
    const eventsPromise = collect(backend.run(makeRequest(controller.signal)));

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(eventsPromise).resolves.toEqual([]);
    expect(query.closed).toBe(true);
    expect(captured?.options.abortController?.signal.aborted).toBe(true);
  });
});

it('sends images as structured SDK input while retaining empty tools and exact resume', async () => {
  let params: ClaudeQueryParams | undefined;
  const backend = new ClaudeBackend(config, { query: queryFactoryFor(new FakeQuery([{ type: 'result', subtype: 'success' }]), value => { params = value; }) });
  await collect(backend.run({ ...makeRequest(new AbortController().signal, 'original-session'),
    images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png', label: 'A.pdf#page=2' }] }));
  expect(params?.options).toMatchObject({ resume: 'original-session', tools: [], mcpServers: {}, settingSources: [] });
  expect(typeof params?.prompt).not.toBe('string');
  const messages = [];
  if (params && typeof params.prompt !== 'string') for await (const message of params.prompt) messages.push(message);
  expect(messages).toHaveLength(1);
  expect(messages[0]?.message.content).toEqual([
    { type: 'text', text: 'Explain this selection.' }, { type: 'text', text: 'A.pdf#page=2' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ]);
});

it('reports the answer model rather than the first auxiliary model usage entry', async () => {
  const query = new FakeQuery([
    { type: 'system', subtype: 'init', session_id: 's', model: 'answer-model' },
    { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: {
      'helper-model': { outputTokens: 2, inputTokens: 3 }, 'answer-model': { outputTokens: 18, inputTokens: 7 },
    } },
  ]);
  const backend = new ClaudeBackend(config, { query: queryFactoryFor(query) });
  const events = await collect(backend.run(makeRequest(new AbortController().signal)));
  expect(events.at(-1)).toMatchObject({ type: 'done', usage: { model: 'answer-model', inputTokens: 10, outputTokens: 20 } });
});

it('uses the last assistant input including cache instead of accumulated multi-turn usage', async () => {
  const query = new FakeQuery([
    { type: 'assistant', message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'assistant', message: { content: [], usage: { input_tokens: 15, cache_read_input_tokens: 120, cache_creation_input_tokens: 0 } } },
    { type: 'result', subtype: 'success', num_turns: 2, usage: { input_tokens: 25, cache_read_input_tokens: 220, cache_creation_input_tokens: 20 } },
  ]);
  const backend = new ClaudeBackend(config, { query: queryFactoryFor(query) });
  const events = await collect(backend.run(makeRequest(new AbortController().signal)));
  expect(events.filter(event => event.type === 'runtime')).toEqual([
    { type: 'runtime', runtime: { contextTokens: 130 } },
    { type: 'runtime', runtime: { contextTokens: 135 } },
  ]);
  expect(events.at(-1)).toEqual({ type: 'done', usage: { inputTokens: 25, cacheReadTokens: 220, cacheWriteTokens: 20 } });
});

it('allows only native web tools in a separate request and reports completed tool results', async () => {
  const query = new FakeQuery([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: { query: 'example' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', content: 'https://example.com' }] } },
    { type: 'result', subtype: 'success', result: 'https://example.com' },
  ]);
  let options: ClaudeQueryParams | undefined;
  const backend = new ClaudeBackend(config, { query: queryFactoryFor(query, p => { options = p; }) });
  const events = await collect(backend.run({ ...makeRequest(new AbortController().signal), webAccess: true }));
  expect(events).toContainEqual({ type: 'web-tool', name: 'WebSearch' });
  expect(options?.options).toMatchObject({ tools: ['WebSearch', 'WebFetch'], allowedTools: ['WebSearch', 'WebFetch'], mcpServers: {}, skills: [] });
  expect(options?.options.resume).toBeUndefined();
});

it('does not report a failed web tool as successful evidence', async () => {
  const query = new FakeQuery([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search-1', name: 'WebSearch', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1', is_error: true, content: 'Unavailable' }] } },
    { type: 'result', subtype: 'success', result: 'Unable to search.' },
  ]);
  const events = await collect(new ClaudeBackend(config, { query: queryFactoryFor(query) }).run({
    ...makeRequest(new AbortController().signal), webAccess: true,
  }));
  expect(events.some(e => e.type === 'web-tool')).toBe(false);
});

it('reports CLI retry activity without turning it into answer text or a terminal error', async () => {
  const query = new FakeQuery([
    { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1000, error_status: null },
    { type: 'result', subtype: 'success', result: 'OK' },
  ]);
  const events = await collect(new ClaudeBackend(config, { query: queryFactoryFor(query) }).run(makeRequest(new AbortController().signal)));
  expect(events).toContainEqual({ type: 'progress', message: expect.stringContaining('1/3') });
  expect(events).toContainEqual({ type: 'text', text: 'OK' });
  expect(events.some(e => e.type === 'error')).toBe(false);
});
