import { setIcon } from 'obsidian';

export function iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'study-companion-icon-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  setIcon(button, icon);
  parent.appendChild(button);
  return button;
}

export function addCopyAnswer(parent: HTMLElement, answer: string, onError: (error: unknown) => void): void {
  if (!answer) return;
  const button = iconButton(parent, 'copy', '复制回答 Markdown');
  button.addEventListener('click', () => {
    button.disabled = true;
    void (async () => {
      try {
        const clipboard = parent.ownerDocument.defaultView?.navigator.clipboard;
        if (!clipboard) throw new Error('当前窗口无法访问剪贴板。');
        await clipboard.writeText(answer);
        if (!button.isConnected) return;
        setIcon(button, 'check');
        button.title = '已复制';
        button.setAttribute('aria-label', '已复制');
      } catch (error) { onError(error); }
      finally { button.disabled = false; }
    })();
  });
}

export function resizeComposer(input: HTMLTextAreaElement): void {
  const minimum = Number(input.dataset.minHeight) || 48;
  const maximum = Number(input.dataset.maxHeight) || 200;
  input.style.height = '0px';
  const styles = input.ownerDocument.defaultView?.getComputedStyle(input);
  const borderHeight = (parseFloat(styles?.borderTopWidth ?? '') || 0) + (parseFloat(styles?.borderBottomWidth ?? '') || 0);
  const contentHeight = input.scrollHeight + borderHeight;
  input.style.height = `${Math.min(maximum, Math.max(minimum, contentHeight))}px`;
  input.style.overflowY = contentHeight > maximum ? 'auto' : 'hidden';
}

export function addLatestButton(messages: HTMLElement, jump: () => void): HTMLButtonElement {
  const container = messages.ownerDocument.createElement('div');
  container.className = 'study-companion-latest';
  messages.after(container);
  const button = iconButton(container, 'arrow-down', '回到最新回答');
  button.hidden = true;
  button.addEventListener('click', jump);
  return button;
}
