import { sourceNavigationTarget } from './source-navigation';
import { type App } from 'obsidian';
import type { StudyRecord, StudyUnit } from '../core/contracts';

/** Deterministic page navigation remains available even when a model omits citations. */
export function addPdfSourceLinks(parent: HTMLElement, app: App, record: StudyRecord, unit?: StudyUnit): void {
  if (record.evidenceMode === 'conversation') return;
  for (const [index, source] of [record.requestEvidence ?? record.context, ...(record.attachments ?? [])].entries()) {
    const pages = source.pdf?.pages ?? source.sourcePages;
    if (!pages || source.answerRecordId) continue;
    const currentPath = index === 0 && unit && unit.id === record.unitId && unit.mode !== 'normal'
      ? unit.sourcePath || source.sourcePath : source.sourcePath;
    const currentName = currentPath === source.sourcePath ? source.sourceName
      : currentPath.split('/').at(-1)?.replace(/\.pdf$/i, '') ?? source.sourceName;
    const details = parent.ownerDocument.createElement('details');
    details.className = 'study-companion-pdf-links';
    const summary = parent.ownerDocument.createElement('summary');
    summary.textContent = `${currentName} · 来源页`;
    details.append(summary);
    for (const page of pages) {
      const link = parent.ownerDocument.createElement('a');
      link.href = `${currentPath.split('/').map(encodeURIComponent).join('/')}#page=${page}`;
      link.textContent = `第 ${page} 页`;
      link.addEventListener('click', event => {
        event.preventDefault();
        void app.workspace.openLinkText(sourceNavigationTarget(`${currentPath}#page=${page}`), '', false);
      });
      details.append(link);
    }
    parent.append(details);
  }
}
