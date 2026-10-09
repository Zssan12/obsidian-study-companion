// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderContextMeter } from '../../src/ui/context-meter';
import { renderSourcePreview } from '../../src/ui/source-preview';
import type { SourceContext } from '../../src/core/contracts';

it('reports real usage and clears it when the current scope has no report', () => {
  const root = document.createElement('div');
  renderContextMeter(root, { contextTokens: 25000, contextWindow: 100000 });
  const button = root.querySelector('button')!;
  expect(button.getAttribute('aria-label')).toContain('25%');
  expect(button.getAttribute('aria-label')).toContain('100,000');
  renderContextMeter(root);
  expect(root.querySelector('button')).toBe(button);
  expect(button.classList.contains('is-unknown')).toBe(true);
  expect(button.getAttribute('aria-label')).not.toContain('25,000');
  renderContextMeter(root, { contextTokens: 0, contextWindow: 100000 });
  expect(button.classList.contains('is-unknown')).toBe(false);
});

it('bounds long references to 15 numbered lines and clips huge individual lines without HTML execution', () => {
  const root = document.createElement('div');
  const source = { sourcePath: 'A.md', selectedText: ['<script>alert(1)</script>', 'x'.repeat(10000), ...Array.from({ length: 30 }, (_, i) => String(i))] .join('\n') } as SourceContext;
  renderSourcePreview(root, source);
  expect(root.querySelectorAll('li')).toHaveLength(15);
  expect(root.textContent).toContain('还剩 17 行');
  expect(root.querySelectorAll('li')[1]!.textContent!.length).toBe(241);
  expect(root.querySelector('script')).toBeNull();
});
