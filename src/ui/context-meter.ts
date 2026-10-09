import type { StudyRuntimeInfo } from '../core/contracts';

export function renderContextMeter(root: HTMLElement, runtime?: StudyRuntimeInfo): void {
  let button = root.querySelector<HTMLButtonElement>('.study-companion-context-meter');
  if (!button) {
    button = root.ownerDocument.createElement('button'); button.type = 'button';
    button.className = 'study-companion-context-meter'; root.append(button);
    // Bare aria-label uses Obsidian's 1 s delay, except just after another tooltip.
    button.setAttribute('data-tooltip-delay', '150');
    const ring = root.ownerDocument.createElement('span'); ring.className = 'study-companion-context-ring'; ring.setAttribute('aria-hidden', 'true'); button.append(ring);
  }
  const used = runtime?.contextTokens; const total = runtime?.contextWindow;
  const known = used !== undefined && Number.isFinite(used) && used >= 0 && total !== undefined && Number.isFinite(total) && total > 0;
  const ratio = known ? Math.min(1, used / total) : 0;
  button.style.setProperty('--context-ratio', `${ratio * 100}%`);
  button.classList.toggle('is-unknown', !known);
  const count = (n?: number) => n === undefined || !Number.isFinite(n) || n < 0 ? '—' : n.toLocaleString('zh-CN');
  const usedText = count(used); const totalText = total === 0 ? '—' : count(total);
  const text = usedText === '—' && totalText === '—' ? '上下文 · 暂无数据'
    : `上下文${known ? ` · ${Math.round(used / total * 100)}%` : ''}\n${usedText} / ${totalText} tokens`;
  // Obsidian renders aria-label tooltips; a second DOM tooltip would overlap it.
  button.setAttribute('aria-label', text);
}
