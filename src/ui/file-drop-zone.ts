export class FileDropZone {
  private readonly cleanup: (() => void)[] = [];
  private readonly input: HTMLInputElement;
  private readonly hint: HTMLElement;
  private depth = 0;
  constructor(private readonly root: HTMLElement, actions: HTMLElement, accept: string, private readonly add: (files: File[]) => Promise<void>, label = '添加文件 / 图片') {
    this.hint = root.ownerDocument.createElement('div');
    this.hint.className = 'study-companion-drop-hint'; this.hint.setAttribute('role', 'status');
    this.hint.hidden = true;
    root.append(this.hint);
    this.input = root.ownerDocument.createElement('input'); this.input.type = 'file';
    this.input.multiple = true; this.input.accept = accept; this.input.hidden = true; root.append(this.input);
    const button = root.ownerDocument.createElement('button');
    button.type = 'button'; button.textContent = label;
    button.title = label === '添加文件 / 图片' ? '支持拖入文件和粘贴截图；发送前仅保存到本地' : '支持多选或拖入文件；点击开始后才读取'; actions.append(button);
    const listen = <Key extends keyof HTMLElementEventMap>(target: HTMLElement, name: Key, handler: (event: HTMLElementEventMap[Key]) => void) => {
      target.addEventListener(name, handler); this.cleanup.push(() => target.removeEventListener(name, handler));
    };
    listen(button, 'click', () => { const menu = button.closest('details'); if (menu) menu.open = false; this.input.click(); });
    listen(this.input, 'change', () => { const files = Array.from(this.input.files ?? []); this.input.value = ''; void this.add(files); });
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    listen(root, 'dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.depth++; root.classList.add('study-companion-drop-active'); });
    listen(root, 'dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
    listen(root, 'dragleave', event => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); if (--this.depth <= 0) this.reset(); });
    listen(root, 'drop', event => { if (!hasFiles(event)) return; event.preventDefault(); event.stopPropagation(); this.reset(); void this.add(Array.from(event.dataTransfer?.files ?? [])); });
    listen(root, 'paste', event => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); void this.add(files);
    });
  }
  status(text: string): void { this.hint.textContent = text; this.hint.hidden = !text; }
  private reset(): void { this.depth = 0; this.root.classList.remove('study-companion-drop-active'); }
  dispose(): void { this.reset(); this.cleanup.forEach(dispose => dispose()); }
}
