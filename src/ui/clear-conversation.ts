import { Modal, type App } from 'obsidian';

export function confirmClearConversation(app: App, action: () => Promise<void>): Promise<boolean> {
  return new Promise(resolve => {
    class ClearModal extends Modal {
      private completed = false;
      private busy = false;
      onOpen(): void {
        const doc = this.contentEl.ownerDocument;
        const heading = doc.createElement('h2'); heading.textContent = '清空当前对话？';
        const hint = doc.createElement('p'); hint.textContent = '本对话问答将移入“已删除”，可恢复。AI 上下文、用量和已讲进度会重置；目录、收藏、原始资料与已整理笔记保留。';
        const status = doc.createElement('p'); status.setAttribute('role', 'status');
        const actions = doc.createElement('div'); actions.className = 'study-companion-note-actions';
        const cancel = doc.createElement('button'); cancel.textContent = '取消'; cancel.type = 'button';
        const confirm = doc.createElement('button'); confirm.textContent = '清空对话'; confirm.type = 'button'; confirm.className = 'mod-warning';
        cancel.addEventListener('click', () => this.close());
        confirm.addEventListener('click', () => {
          if (this.busy) return;
          this.busy = true; confirm.disabled = true; cancel.disabled = true;
          void action().then(() => { this.completed = true; this.close(); }, error => {
            status.textContent = error instanceof Error ? error.message : '清空失败，请重试。';
          }).finally(() => { this.busy = false; confirm.disabled = false; cancel.disabled = false; });
        });
        actions.append(cancel, confirm); this.contentEl.replaceChildren(heading, hint, status, actions); cancel.focus();
      }
      onClose(): void { resolve(this.completed); }
    }
    new ClearModal(app).open();
  });
}
