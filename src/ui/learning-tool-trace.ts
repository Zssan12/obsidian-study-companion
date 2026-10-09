import { isVaultNotePath, type LearningToolStep } from '../core/learning-tools';
import { renderSourcePreview } from './source-preview';

export function renderLearningToolTrace(article: HTMLElement, trace: LearningToolStep[] | undefined, open: (path: string) => void): void {
  let root = article.querySelector<HTMLElement>('.study-companion-tool-trace');
  if (!trace?.length) { root?.remove(); return; }
  if (!root) { root = article.ownerDocument.createElement('div'); root.className = 'study-companion-tool-trace'; article.append(root); }
  const signature = JSON.stringify(trace);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  const existing = Array.from(root.children) as HTMLDetailsElement[];
  for (const [index, step] of trace.entries()) {
    const identity = JSON.stringify(step);
    if (existing[index]?.dataset.step === identity) continue;
    const details = article.ownerDocument.createElement('details'); details.className = 'study-companion-context-details';
    details.open = existing[index]?.open ?? false;
    details.dataset.step = identity;
    const summary = article.ownerDocument.createElement('summary'); summary.className = 'study-companion-context-summary';
    const labels = { Read: '读取', Grep: '搜索笔记', Glob: '查找文件', WebSearch: '联网搜索', WebFetch: '读取网页' };
    summary.textContent = `${step.evidenceId ? step.evidenceId + ' · ' : ''}${labels[step.tool]} · ${step.input}${step.error ? ' · 未完成' : ''}`;
    details.append(summary);
    const preview = article.ownerDocument.createElement('div');
    let text = step.text;
    if (!step.error && (step.tool === 'Glob' || step.tool === 'Grep')) {
      renderSearchResults(preview, step, open);
    } else {
      if (step.tool === 'Read') text = text.replace(/^\d+: /gmu, '');
      renderSourcePreview(preview, { sourcePath: step.path ?? '', sourceName: step.input, selectedText: text,
        before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } }, step.startLine ?? 1);
    }
    details.append(preview);
    if (step.path && !step.error) {
      const button = article.ownerDocument.createElement('button'); button.type = 'button'; button.textContent = '打开笔记';
      button.addEventListener('click', () => open(step.path!)); details.append(button);
    }
    if (existing[index]) existing[index]!.replaceWith(details); else root.append(details);
  }
  for (const extra of existing.slice(trace.length)) extra.remove();
}

/** Stored tool data is not presentation text. Decode it without rendering markup or arbitrary links. */
function renderSearchResults(root: HTMLElement, step: LearningToolStep, open: (path: string) => void): void {
  root.className = 'study-companion-search-results';
  const doc = root.ownerDocument;
  const note = (text: string): void => { const p = doc.createElement('p'); p.className = 'study-companion-search-status'; p.textContent = text; root.append(p); };
  const fileButton = (parent: HTMLElement, path: string): void => {
    const button = doc.createElement('button'); button.type = 'button';
    button.className = 'study-companion-search-file'; button.textContent = path.split('/').at(-1)!;
    button.title = path; button.setAttribute('aria-label', `打开笔记 ${path}`);
    button.addEventListener('click', () => open(path)); parent.append(button);
  };
  try {
    const data: unknown = JSON.parse(step.text);
    if (!data || typeof data !== 'object') throw new Error('Invalid search result');
    const object = data as Record<string, unknown>;
    if (step.tool === 'Glob') {
      if (!Array.isArray(object.files) || !object.files.every(path => typeof path === 'string' && isVaultNotePath(path))) throw new Error('Invalid files');
      const paths = object.files as string[];
      note(paths.length ? `展示 ${Math.min(paths.length, 15)} 篇匹配笔记` : object.remaining ? '匹配文件名较长，未在此展开。' : '没有找到匹配的笔记。');
      for (const path of paths.slice(0, 15)) fileButton(root, path);
      const rest = Math.max(0, paths.length - 15) + (typeof object.remaining === 'number' && Number.isSafeInteger(object.remaining) && object.remaining > 0 ? object.remaining : 0);
      if (rest) note(`还有 ${rest} 篇未展示，可缩小搜索范围。`);
      return;
    }
    if (!Array.isArray(object.hits)) throw new Error('Invalid hits');
    const groups = new Map<string, { line: number; text: string }[]>();
    for (const value of object.hits.slice(0, 15)) {
      if (!value || typeof value !== 'object') throw new Error('Invalid hit');
      const hit = value as Record<string, unknown>;
      if (typeof hit.path !== 'string' || !isVaultNotePath(hit.path) || typeof hit.text !== 'string'
        || typeof hit.line !== 'number' || !Number.isSafeInteger(hit.line) || hit.line < 1) throw new Error('Invalid hit');
      const hits = groups.get(hit.path) ?? []; hits.push({ line: hit.line, text: hit.text }); groups.set(hit.path, hits);
    }
    note(groups.size ? `${groups.size} 篇笔记 · ${Math.min(object.hits.length, 15)} 处匹配` : object.remainingHits ? '匹配内容超过展示范围。' : '没有找到匹配内容。');
    for (const [path, hits] of groups) {
      const group = doc.createElement('section'); group.className = 'study-companion-search-file-group'; fileButton(group, path);
      for (const hit of hits) {
        const p = doc.createElement('p'); p.className = 'study-companion-search-hit';
        const line = doc.createElement('span'); line.className = 'study-companion-search-line'; line.textContent = `第 ${hit.line} 行`;
        const snippet = doc.createElement('span'); snippet.textContent = hit.text;
        p.append(line, snippet); group.append(p);
      }
      root.append(group);
    }
    const remainingHits = Math.max(0, object.hits.length - 15) + (typeof object.remainingHits === 'number' && Number.isSafeInteger(object.remainingHits) && object.remainingHits > 0 ? object.remainingHits : 0);
    if (remainingHits) note(`还有 ${remainingHits} 处匹配未展示。`);
    if (object.incomplete === true) note('仅检查了部分笔记，可缩小范围后继续查找。');
  } catch {
    root.replaceChildren(); note('搜索结果不完整，暂时无法展示匹配列表。');
  }
}
