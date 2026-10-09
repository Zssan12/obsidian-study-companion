// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { addCopyAnswer, resizeComposer } from '../../src/ui/chat-interactions';

vi.mock('obsidian', () => ({ setIcon: vi.fn() }));
afterEach(() => { document.body.replaceChildren(); });

it('copies the original Markdown rather than rendered text', async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const parent = document.createElement('div'); document.body.appendChild(parent);
  const markdown = '| A | B |\n|---|---|\n| $x$ | **y** |';
  addCopyAnswer(parent, markdown, vi.fn());
  parent.querySelector('button')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
  expect(parent.querySelector('button')!.title).toBe('已复制');
});

it('reports clipboard failure and permits another attempt', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
  const parent = document.createElement('div');
  const onError = vi.fn();
  addCopyAnswer(parent, 'answer', onError);
  parent.querySelector('button')!.click();
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  expect(parent.querySelector('button')!.disabled).toBe(false);
});

it('fits border-box content, caps long input, and shrinks after clearing', () => {
  const input = document.createElement('textarea');
  input.style.border = '1px solid';
  Object.defineProperty(input, 'scrollHeight', { value: 92, configurable: true });
  resizeComposer(input);
  expect(input.style.height).toBe('94px');
  expect(input.style.overflowY).toBe('hidden');
  Object.defineProperty(input, 'scrollHeight', { value: 500, configurable: true });
  resizeComposer(input);
  expect(input.style.height).toBe('200px');
  expect(input.style.overflowY).toBe('auto');
  Object.defineProperty(input, 'scrollHeight', { value: 30 });
  resizeComposer(input);
  expect(input.style.height).toBe('48px');
  expect(input.style.overflowY).toBe('hidden');
});
