import { App, Modal } from 'obsidian';
import type { ModelProvider } from './model-controls';

export interface ProviderPickerOptions {
  initial: ModelProvider;
  signal?: AbortSignal;
  title?: string;
  description?: string;
  confirmLabel?: string;
}

/** Provider choice belongs to conversation creation, never to the ongoing composer. */
export function pickConversationProvider(app: App, options: ProviderPickerOptions): Promise<ModelProvider | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    class ProviderPicker extends Modal {
      private selected: ModelProvider | null = null;
      onOpen(): void {
        const doc = this.contentEl.ownerDocument;
        this.contentEl.classList.add('study-companion-provider-picker');
        const title = doc.createElement('h2'); title.textContent = options.title ?? '新对话';
        const hint = doc.createElement('p');
        hint.textContent = options.description ?? '选择使用的助手，模型可在发送前调整。';
        const form = doc.createElement('form');
        const choices = doc.createElement('fieldset');
        const legend = doc.createElement('legend'); legend.textContent = '使用哪个助手';
        choices.append(legend);
        let initial: HTMLInputElement | undefined;
        for (const [value, text] of [['claude', 'Claude'], ['codex', 'Codex']]) {
          const label = doc.createElement('label'); label.className = 'study-companion-provider-option';
          const radio = doc.createElement('input'); radio.type = 'radio'; radio.name = 'provider'; radio.value = value!;
          radio.checked = value === options.initial;
          if (radio.checked) initial = radio;
          const name = doc.createElement('span'); name.textContent = text!;
          label.append(radio, name); choices.append(label);
        }
        const actions = doc.createElement('div'); actions.className = 'study-companion-note-actions';
        const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
        cancel.addEventListener('click', () => this.close());
        const create = doc.createElement('button'); create.type = 'submit'; create.textContent = options.confirmLabel ?? '开始对话'; create.className = 'mod-cta';
        form.addEventListener('submit', event => {
          event.preventDefault();
          this.selected = form.querySelector<HTMLInputElement>('input:checked')!.value as ModelProvider;
          this.close();
        });
        actions.append(cancel, create);
        form.append(choices, actions);
        this.contentEl.replaceChildren(title, hint, form);
        initial?.focus();
      }
      onClose(): void { options.signal?.removeEventListener('abort', cancel); this.contentEl.replaceChildren(); resolve(this.selected); }
    }
    const picker = new ProviderPicker(app);
    const cancel = (): void => { picker.close(); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    picker.open();
  });
}
