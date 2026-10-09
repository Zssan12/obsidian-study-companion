// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { StableMessages } from '../../src/ui/stable-messages';

interface Item { id: string; text: string }

function renderer(create = vi.fn((item: Item) => {
  const element = document.createElement('article');
  element.textContent = item.text;
  return element;
})) {
  return {
    create,
    key: (item: Item) => item.id,
    update: (element: HTMLElement, item: Item) => {
      if (element.textContent !== item.text) element.textContent = item.text;
    },
  };
}

describe('stable messages', () => {
  it('keeps unchanged keyed elements, focus, and text selection mounted', () => {
    const container = document.createElement('main');
    document.body.append(container);
    const messages = new StableMessages(container);
    const config = renderer();
    messages.reconcile([{ id: 'a', text: 'select me' }, { id: 'b', text: 'keep focus' }], config);
    const first = container.children[0] as HTMLElement;
    const second = container.children[1] as HTMLElement;
    second.tabIndex = 0;
    second.focus();
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(first);
    selection.removeAllRanges();
    selection.addRange(range);

    messages.reconcile([{ id: 'a', text: 'select me' }, { id: 'b', text: 'keep focus' }], config);

    expect(Array.from(container.children)).toEqual([first, second]);
    expect(document.activeElement).toBe(second);
    expect(selection.toString()).toBe('select me');
    expect(config.create).toHaveBeenCalledTimes(2);
  });

  it('reorders existing nodes and removes only keys that disappeared', () => {
    const container = document.createElement('main');
    const messages = new StableMessages(container);
    const config = renderer();
    messages.reconcile([
      { id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' },
    ], config);
    const [a, b, c] = Array.from(container.children);

    messages.reconcile([{ id: 'c', text: 'C' }, { id: 'a', text: 'A' }], config);

    expect(Array.from(container.children)).toEqual([c, a]);
    expect(b!.isConnected).toBe(false);
    expect(config.create).toHaveBeenCalledTimes(3);
  });

  it('rejects duplicate keys before changing the DOM', () => {
    const container = document.createElement('main');
    const messages = new StableMessages(container);
    const config = renderer();
    messages.reconcile([{ id: 'a', text: 'original' }], config);
    const original = container.firstChild;

    expect(() => messages.reconcile([
      { id: 'a', text: 'first' }, { id: 'a', text: 'second' },
    ], config)).toThrow('Stable message keys must be unique.');
    expect(container.firstChild).toBe(original);
    expect(container.textContent).toBe('original');
  });
});
