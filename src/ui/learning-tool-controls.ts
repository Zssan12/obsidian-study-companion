import type { LearningToolStep } from '../core/learning-tools';

/** Reports request-scoped activity; it never changes permissions or starts a request. */
export function renderComposerActivity(root: HTMLElement, message: string, error: boolean, trace?: LearningToolStep[]): void {
  const used = new Set<string>();
  for (const step of trace ?? []) {
    if (step.error) continue;
    used.add(step.tool === 'WebSearch' || step.tool === 'WebFetch' ? '联网搜索' : '笔记资料');
  }
  const suffix = used.size ? `已使用：${[...used].join(' · ')}` : '';
  root.textContent = [message, error ? '' : suffix].filter(Boolean).join(' · ');
  root.classList.add('study-companion-composer-activity');
  root.classList.toggle('is-error', error);
  root.removeAttribute('title');
}
