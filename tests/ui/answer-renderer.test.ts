// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, Component, MarkdownRenderer } from 'obsidian';
import { AnswerRenderer, bindAnswerLinks, normalizeObsidianMath } from '../../src/ui/answer-renderer';

vi.mock('obsidian', () => {
  class MockComponent {
    children = new Set<MockComponent>();
    callbacks: (() => void)[] = [];
    loaded = false;
    load(): void {
      this.loaded = true;
      for (const child of this.children) child.load();
    }
    unload(): void {
      if (!this.loaded) return;
      this.loaded = false;
      for (const child of this.children) child.unload();
      for (const callback of this.callbacks.splice(0)) callback();
    }
    addChild<T extends MockComponent>(child: T): T {
      this.children.add(child);
      if (this.loaded) child.load();
      return child;
    }
    removeChild<T extends MockComponent>(child: T): T {
      this.children.delete(child);
      child.unload();
      return child;
    }
    register(callback: () => void): void { this.callbacks.push(callback); }
  }
  return { Component: MockComponent, MarkdownRenderer: { render: vi.fn() } };
});

const render = vi.mocked(MarkdownRenderer.render);
const app = {} as App;

function setup(): { parent: Component; renderer: AnswerRenderer; container: HTMLDivElement } {
  const parent = new Component();
  parent.load();
  return { parent, renderer: new AnswerRenderer(app, parent), container: document.createElement('div') };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('native answer rendering', () => {
  beforeEach(() => {
    render.mockReset();
    render.mockImplementation(async (_app, markdown, element) => { element.textContent = markdown; });
  });

  it('opens rendered local citations through the workspace while leaving web links alone', () => {
    const openLinkText = vi.fn(async () => {});
    const linkedApp = { workspace: { openLinkText } } as unknown as App;
    const container = document.createElement('div');
    container.innerHTML = '<a data-href="/%E8%AF%BE%E4%BB%B6/Test.pdf#page=8">第 8 页</a><a href="https://example.com">网页</a>';
    bindAnswerLinks(linkedApp, container, '课件/Test.pdf');
    container.querySelector<HTMLAnchorElement>('a')!.click();
    expect(openLinkText).toHaveBeenCalledWith('课件/Test.pdf#page=8&offset=0,,0', '课件/Test.pdf', false);
    const web = container.querySelectorAll<HTMLAnchorElement>('a')[1]!;
    web.addEventListener('click', event => event.preventDefault());
    web.click();
    expect(openLinkText).toHaveBeenCalledOnce();
  });

  it('handles app-local PDF URLs and modifier clicks without intercepting other protocols', () => {
    const openLinkText = vi.fn(async () => {});
    const container = document.createElement('div');
    container.innerHTML = '<a href="app://obsidian.md/Course%20notes/FFT.pdf#page=10"><span>第 10 页</span></a><a href="obsidian://open?vault=test">应用链接</a><a href="//example.com/test">网站</a>';
    bindAnswerLinks({ workspace: { openLinkText } } as unknown as App, container, 'Course notes/FFT.pdf');
    container.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(openLinkText).toHaveBeenCalledWith('Course notes/FFT.pdf#page=10&offset=0,,0', 'Course notes/FFT.pdf', true);
    for (const link of Array.from(container.querySelectorAll('a')).slice(1)) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      let intercepted = false;
      link.addEventListener('click', e => { intercepted = e.defaultPrevented; e.preventDefault(); });
      link.dispatchEvent(event); expect(intercepted).toBe(false);
    }
    expect(openLinkText).toHaveBeenCalledOnce();
  });

  it('passes Markdown and inline/display math unchanged to Obsidian with the bound source path', async () => {
    const { parent, renderer, container } = setup();
    const answer = '# Result\n\n$x^2$\n\n$$\\frac{a}{b}$$\n\n[[Related]]';
    await renderer.update('answer', container, answer, 'notes/source.md');
    expect(render).toHaveBeenCalledWith(app, answer, expect.any(HTMLElement), 'notes/source.md', expect.any(Component));
    expect(container.textContent).toBe(answer);
    const node = container.firstChild;
    await renderer.update('answer', container, answer, 'notes/source.md');
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.firstChild).toBe(node);
    parent.unload();
  });

  it('adapts provider LaTeX delimiters for Obsidian without changing code examples', async () => {
    const markdown = '行内 \\(x^2\\)，展示：\n\\[\\frac{a}{b}\\]\n`\\(literal\\)`\n```tex\n\\[literal\\]\n```';
    expect(normalizeObsidianMath(markdown)).toBe('行内 $x^2$，展示：\n$$\\frac{a}{b}$$\n`\\(literal\\)`\n```tex\n\\[literal\\]\n```');
    const { parent, renderer, container } = setup();
    await renderer.update('answer', container, markdown, 'source.md');
    expect(render).toHaveBeenCalledWith(app, '行内 $x^2$，展示：\n$$\\frac{a}{b}$$\n`\\(literal\\)`\n```tex\n\\[literal\\]\n```', expect.any(HTMLElement), 'source.md', expect.any(Component));
    parent.unload();
  });

  it('preserves multiline inline code, tilde fences and escaped delimiters', () => {
    const code = '`first\n\\(literal\\)\nlast`\n~~~tex\n\\[literal\\]\n~~~';
    expect(normalizeObsidianMath(code)).toBe(code);
    const escaped = String.raw`\\(literal\\)`;
    expect(normalizeObsidianMath(escaped)).toBe(escaped);
  });

  it('renders math after an escaped literal backtick without treating it as code', () => {
    const markdown = '反引号写作 \\`。公式：\\(x^2\\)。\n\n\\[y^2\\]';
    expect(normalizeObsidianMath(markdown)).toBe('反引号写作 \\`。公式：$x^2$。\n\n$$y^2$$');
  });

  it('keeps backslash-ending code spans intact and counts escaped backslashes before ticks', () => {
    const markdown = '`path\\` 后面的公式 \\(x\\)。';
    expect(normalizeObsidianMath(markdown)).toBe('`path\\` 后面的公式 $x$。');
    const evenSlashes = '\\\\`\\(code\\)` 后面的公式 \\(y\\)。';
    expect(normalizeObsidianMath(evenSlashes)).toBe('\\\\`\\(code\\)` 后面的公式 $y$。');
  });

  it('defers native Markdown/math while streaming and renders even unchanged text on completion', async () => {
    const { parent, renderer, container } = setup();
    const answer = '$$x^2$$';
    await renderer.update('answer', container, answer, 'source.md', { streaming: true, deferMath: true });
    expect(render).not.toHaveBeenCalled();
    expect(container.textContent).toBe(answer);
    expect(container.classList.contains('study-companion-answer-plain')).toBe(true);
    await renderer.update('answer', container, answer, 'source.md', { deferMath: true });
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.classList.contains('study-companion-answer-plain')).toBe(false);
    parent.unload();
  });

  it('coalesces pending snapshots and prevents stale content from reaching the answer', async () => {
    const { parent, renderer, container } = setup();
    const gate = deferred();
    const released = vi.fn();
    render.mockImplementationOnce(async (_app, markdown, element, _source, component) => {
      component.register(released);
      await gate.promise;
      element.textContent = markdown;
    });
    const first = renderer.update('answer', container, 'old', 'source.md');
    const second = renderer.update('answer', container, 'middle', 'source.md');
    const latest = renderer.update('answer', container, 'latest', 'source.md');
    expect(render).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
    gate.resolve();
    await Promise.all([first, second, latest]);
    expect(render.mock.calls.map((call) => call[1])).toEqual(['old', 'latest']);
    expect(container.textContent).toBe('latest');
    expect(released).toHaveBeenCalledTimes(1);
    parent.unload();
  });

  it('rerenders unchanged Markdown when the source path changes and releases the prior component', async () => {
    const { parent, renderer, container } = setup();
    const released = vi.fn();
    render.mockImplementation(async (_app, text, element, source, component) => {
      element.textContent = `${source}:${text}`;
      component.register(released);
    });
    await renderer.update('answer', container, '[[Relative]]', 'a/source.md');
    await renderer.update('answer', container, '[[Relative]]', 'b/source.md');
    expect(container.textContent).toBe('b/source.md:[[Relative]]');
    expect(released).toHaveBeenCalledTimes(1);
    parent.unload();
    expect(released).toHaveBeenCalledTimes(2);
  });

  it('keeps deferred streaming text visible when an older native render finishes', async () => {
    const { parent, renderer, container } = setup();
    const gate = deferred();
    render.mockImplementationOnce(async (_app, text, element) => {
      await gate.promise;
      element.textContent = text;
    });
    const pending = renderer.update('answer', container, 'old', 'source.md');
    const latest = renderer.update('answer', container, '$unfinished', 'source.md', { streaming: true, deferMath: true });
    expect(container.textContent).toBe('$unfinished');
    gate.resolve();
    await Promise.all([pending, latest]);
    expect(container.textContent).toBe('$unfinished');
    expect(render).toHaveBeenCalledTimes(1);
    parent.unload();
  });

  it('renders into a replacement container even when the answer key and text are unchanged', async () => {
    const { parent, renderer, container } = setup();
    const released = vi.fn();
    render.mockImplementation(async (_app, text, element, _source, component) => {
      element.textContent = text;
      component.register(released);
    });
    await renderer.update('answer', container, 'answer', 'source.md');
    const replacement = document.createElement('div');
    await renderer.update('answer', replacement, 'answer', 'source.md');
    expect(replacement.textContent).toBe('answer');
    expect(render).toHaveBeenCalledTimes(2);
    expect(released).toHaveBeenCalledTimes(1);
    parent.unload();
  });

  it('invalidates removed keys and releases a render that finishes after removal', async () => {
    const { parent, renderer, container } = setup();
    const gate = deferred();
    const released = vi.fn();
    render.mockImplementationOnce(async (_app, text, element, _source, component) => {
      component.register(released);
      await gate.promise;
      element.textContent = text;
    });
    const pending = renderer.update('answer', container, 'old', 'source.md');
    renderer.retain(new Set());
    expect(released).toHaveBeenCalledTimes(1);
    await renderer.update('answer', container, 'new', 'source.md');
    gate.resolve();
    await pending;
    expect(container.textContent).toBe('new');
    parent.unload();
  });

  it('stops pending work and future updates when its parent unloads', async () => {
    const { parent, renderer, container } = setup();
    const gate = deferred();
    const released = vi.fn();
    render.mockImplementationOnce(async (_app, text, element, _source, component) => {
      component.register(released);
      await gate.promise;
      element.textContent = text;
    });
    const pending = renderer.update('answer', container, 'old', 'source.md');
    parent.unload();
    gate.resolve();
    await pending;
    await renderer.update('answer', container, 'new', 'source.md');
    expect(container.textContent).toBe('');
    expect(render).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('shows failed renders as literal text without inserting untrusted HTML', async () => {
    const { parent, renderer, container } = setup();
    const released = vi.fn();
    render.mockImplementationOnce(async (_app, _text, _element, _source, component) => {
      component.register(released);
      throw new Error('Renderer unavailable');
    });
    const answer = '<img src=x onerror=alert(1)> $unfinished';
    await renderer.update('answer', container, answer, 'source.md');
    expect(container.textContent).toBe(answer);
    expect(container.querySelector('img')).toBeNull();
    expect(released).toHaveBeenCalledTimes(1);
    parent.unload();
  });
});
