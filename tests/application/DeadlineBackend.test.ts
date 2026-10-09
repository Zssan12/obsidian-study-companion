import { expect, it, vi } from 'vitest';
import { DeadlineBackend } from '../../src/application/DeadlineBackend';
import type { BackendEvent, StudyBackend } from '../../src/core/contracts';
it('aborts a stalled call, reports timeout, and leaves caller cancellation separate', async () => {
  vi.useFakeTimers();
  try {
    const inner: StudyBackend = { async *run(r) { yield { type: 'runtime', runtime: {} }; await new Promise<void>(resolve => r.signal.addEventListener('abort', () => resolve(), { once: true })); }, dispose() {} };
    const events: BackendEvent[] = [];
    const task = (async () => { for await (const event of new DeadlineBackend(inner, 10).run({ requestId: 'r', prompt: '', signal: new AbortController().signal })) events.push(event); })();
    await vi.advanceTimersByTimeAsync(10); await task;
    expect(events.filter(e => e.type === 'error')).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('已停止') })]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('passes normal completions and clears the deadline', async () => {
  const backend = new DeadlineBackend({ async *run() { yield { type: 'done' }; }, dispose() {} });
  const events = []; for await (const event of backend.run({ requestId: 'r', prompt: '', signal: new AbortController().signal })) events.push(event);
  expect(events).toEqual([{ type: 'done' }]);
});
it('a captured wrapper does not dispose a shared backend without capture support', () => {
  const dispose = vi.fn();
  const backend = new DeadlineBackend({ async *run() { yield { type: 'done' }; }, dispose });
  backend.capture().dispose(); expect(dispose).not.toHaveBeenCalled();
  backend.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
});

it('bounds announced recovery without extending it on repeated retry notices', async () => {
  vi.useFakeTimers();
  try {
    const backend: StudyBackend = { async *run(r) {
      yield { type: 'progress', message: 'reconnecting 1/5' };
      yield { type: 'progress', message: 'reconnecting 2/5' };
      await new Promise<void>(resolve => r.signal.addEventListener('abort', () => resolve(), { once: true }));
    }, dispose() {} };
    const events: BackendEvent[] = [];
    const task = (async () => { for await (const e of new DeadlineBackend(backend, 5000, true, 30).run({ requestId: 'r', prompt: '', signal: new AbortController().signal })) events.push(e); })();
    await vi.advanceTimersByTimeAsync(30); await task;
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('仍未恢复') });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('clears recovery timeout after text resumes and never treats user cancellation as timeout', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    const backend: StudyBackend = { async *run(r) {
      yield { type: 'progress', message: 'retry' }; yield { type: 'text', text: 'restored' };
      await new Promise<void>(resolve => r.signal.addEventListener('abort', () => resolve(), { once: true }));
    }, dispose() {} };
    const events: BackendEvent[] = [];
    const task = (async () => { for await (const e of new DeadlineBackend(backend, 5000, true, 30).run({ requestId: 'r', prompt: '', signal: abort.signal })) events.push(e); })();
    await vi.advanceTimersByTimeAsync(40);
    expect(events.map(e => e.type)).toEqual(['progress', 'text']);
    abort.abort(); await task;
    expect(events.some(e => e.type === 'error')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
