import type { SourceContext } from '../core/contracts';

export function sourceTitle(source: SourceContext): string {
  return `${source.sourceName || source.sourcePath.split('/').at(-1) || '模型回答'}${source.answerRecordId ? ' · 回答片段' : ''}`;
}
export function renderSourcePreview(root: HTMLElement, source: SourceContext, startLine = 1): void {
  root.replaceChildren(); root.classList.add('study-companion-source-preview');
  const pages = source.pdf?.pages ?? source.sourcePages;
  if (pages?.length) {
    const location = root.ownerDocument.createElement('small');
    location.textContent = pages.length > 3 ? `已引用 ${pages.length} 页` : `第 ${pages.join('、')} 页`;
    root.append(location);
  }
  const lines = source.selectedText.split(/\r?\n/u);
  const list = root.ownerDocument.createElement('ol'); list.className = 'study-companion-source-lines'; list.style.counterReset = `source-line ${startLine - 1}`;
  for (const line of lines.slice(0, 15)) {
    const item = root.ownerDocument.createElement('li');
    item.textContent = line.length > 240 ? `${line.slice(0, 240)}…` : line || ' ';
    list.append(item);
  }
  root.append(list);
  if (lines.length > 15) {
    const rest = root.ownerDocument.createElement('small'); rest.textContent = `… 还剩 ${lines.length - 15} 行`; root.append(rest);
  }
  if (source.pdf?.indexed) {
    const hint = root.ownerDocument.createElement('small'); hint.textContent = '已导入资料引用；此处不是全文，实际回答按需读取相关页。'; root.append(hint);
  }
}
