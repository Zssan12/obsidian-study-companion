import { followupKind, followupTarget } from '../application/answer-followup';
import type { StudyRecord } from '../core/contracts';
import type { ComposerActions } from './attachment-controls';
import { iconButton } from './chat-interactions';

export function addRecordActions(parent: HTMLElement, record: StudyRecord, actions: ComposerActions | undefined, onError: (error: unknown) => void, records: readonly StudyRecord[] = []): void {
  if (!record.answer || record.state !== 'complete' || record.unsaved) return;
  if (actions?.explainAgain && record.lesson?.kind !== 'plan') {
    const button = parent.ownerDocument.createElement('button');
    const target = followupTarget(record, records);
    const example = !followupKind(target);
    button.type = 'button'; button.textContent = example ? '举例说明' : '继续深入';
    button.addEventListener('click', () => {
      button.disabled = true;
      void actions.explainAgain!(target, example).catch(onError).finally(() => { button.disabled = false; });
    });
    parent.append(button);
  }
  if (actions?.setFavorite) {
    const favorite = iconButton(parent, 'star', record.favorite ? '取消收藏' : '收藏回答');
    favorite.classList.toggle('is-favorite', !!record.favorite);
    favorite.setAttribute('aria-pressed', String(!!record.favorite));
    favorite.addEventListener('click', () => {
      favorite.disabled = true;
      void actions.setFavorite!(record, !record.favorite).catch(onError).finally(() => { favorite.disabled = false; });
    });
  }

}
