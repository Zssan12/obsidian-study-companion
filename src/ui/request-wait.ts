/** Updating a clock must not rerender the answer or the surrounding message list. */
export class RequestWait {
  private readonly entries = new Map<string, { started: number; container: HTMLElement; clock: HTMLElement; label: HTMLElement }>();
  private timer?: number;
  constructor(private readonly win: Window | null) {}

  update(key: string, container: HTMLElement, text: string, started = Date.now()): void {
    let entry = this.entries.get(key);
    if (!entry || entry.container !== container) {
      const row = container.ownerDocument.createElement('div'); row.className = 'study-companion-request-wait';
      const label = container.ownerDocument.createElement('span'); label.setAttribute('role', 'status');
      const clock = container.ownerDocument.createElement('span'); clock.className = 'study-companion-request-clock';
      row.append(label, clock); container.replaceChildren(row);
      entry = { started: entry?.started ?? started, container, label, clock }; this.entries.set(key, entry);
    }
    if (entry.label.textContent !== text) entry.label.textContent = text;
    this.tick();
    this.timer ??= this.win?.setInterval(() => this.tick(), 1000);
  }
  private tick(): void {
    for (const { clock, started } of this.entries.values()) clock.textContent = `已用 ${Math.max(0, Math.floor((Date.now() - started) / 1000))} 秒`;
  }
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key);
    if (!this.entries.size && this.timer !== undefined) { this.win?.clearInterval(this.timer); this.timer = undefined; }
  }
  dispose(): void { this.retain(new Set()); }
}
