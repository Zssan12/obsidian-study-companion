// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RequestWait } from '../../src/ui/request-wait';
afterEach(() => vi.useRealTimers());
it('updates elapsed time without rebuilding nodes and stops after completion or disposal', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const wait = new RequestWait(window); const root = document.createElement('div');
  wait.update('r', root, '正在梳理课件目录', 8000);
  const row = root.firstChild;
  expect(root.textContent).toContain('已用 2 秒');
  vi.advanceTimersByTime(3000);
  wait.update('r', root, '正在合并目录');
  expect(root.firstChild).toBe(row);
  expect(root.textContent).toBe('正在合并目录已用 5 秒');
  const replacement = document.createElement('div');
  wait.update('r', replacement, '正在合并目录');
  expect(replacement.textContent).toContain('已用 5 秒');
  wait.retain(new Set());
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(2000);
  expect(replacement.textContent).toContain('已用 5 秒');
  wait.update('next', root, '正在准备主题讲解');
  wait.dispose(); expect(vi.getTimerCount()).toBe(0);
});
