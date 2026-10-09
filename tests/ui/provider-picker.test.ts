// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { pickConversationProvider } from '../../src/ui/provider-picker';
const host = vi.hoisted(() => ({ modal: undefined as unknown }));
vi.mock('obsidian', () => ({ App: class {}, Modal: class {
  contentEl = document.createElement('div');
  constructor() { host.modal = this; }
  open(): void { document.body.append(this.contentEl); (this as unknown as { onOpen(): void }).onOpen(); }
  close(): void { (this as unknown as { onClose(): void }).onClose(); this.contentEl.remove(); }
} }));
type View = { contentEl: HTMLElement; close(): void };
beforeEach(() => { host.modal = undefined; document.body.replaceChildren(); });
it('only confirms the selected provider when creation is explicitly clicked', async () => {
  const result = pickConversationProvider({} as App, { initial: 'codex' });
  const view = host.modal as View;
  expect(view.contentEl.querySelector<HTMLInputElement>('input:checked')?.value).toBe('codex');
  view.contentEl.querySelector<HTMLInputElement>('input[value="claude"]')!.click();
  view.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!.click();
  await expect(result).resolves.toBe('claude');
});
it('closing or unloading cancels creation rather than accepting the default', async () => {
  const closed = pickConversationProvider({} as App, { initial: 'codex' });
  (host.modal as View).close(); await expect(closed).resolves.toBeNull();
  const abort = new AbortController();
  const pending = pickConversationProvider({} as App, { initial: 'claude', signal: abort.signal });
  abort.abort(); await expect(pending).resolves.toBeNull();
  expect((host.modal as View).contentEl.childElementCount).toBe(0);
});
it('never opens a picker after plugin unload', async () => {
  const abort = new AbortController(); abort.abort();
  await expect(pickConversationProvider({} as App, { initial: 'claude', signal: abort.signal })).resolves.toBeNull();
  expect(host.modal).toBeUndefined();
});
