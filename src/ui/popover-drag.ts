/** Window-local dragging; UI controls and selectable answer text keep their own gestures. */
export class PopoverDrag {
  private readonly doc: Document;
  private readonly win: Window | null;
  private drag?: { pointer: number; x: number; y: number; left: number; top: number };
  private position?: { left: number; top: number };
  private observer?: ResizeObserver;

  constructor(private readonly modal: HTMLElement, private readonly handle: HTMLElement) {
    this.doc = modal.ownerDocument;
    this.win = this.doc.defaultView;
    modal.addEventListener('pointerdown', this.start);
    modal.addEventListener('pointermove', this.hover);
    modal.addEventListener('pointerleave', this.leave);
    handle.addEventListener('lostpointercapture', this.stop);
    this.win?.addEventListener('blur', this.stop);
    this.win?.addEventListener('resize', this.clamp);
    const Observer = this.doc.defaultView?.ResizeObserver;
    if (Observer) { this.observer = new Observer(this.clamp); this.observer.observe(modal); }
  }

  private isHandle(event: PointerEvent): boolean {
    const node = event.target as Element | null;
    if (!node || node.closest('button, a, input, textarea, select, summary, [contenteditable]')) return false;
    if (this.handle.contains(node)) return true;
    // Include the host modal/content padding above and beside the heading, without
    // turning quote, answer or composer content into a drag handle.
    const rect = this.modal.getBoundingClientRect();
    return node.contains(this.handle) && event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= this.handle.getBoundingClientRect().bottom;
  }

  private readonly hover = (event: PointerEvent): void => {
    this.modal.classList.toggle('study-companion-quick-drag-hover', this.isHandle(event));
  };

  private readonly leave = (): void => {
    this.modal.classList.remove('study-companion-quick-drag-hover');
  };

  private readonly start = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drag || !this.isHandle(event)) return;
    const rect = this.modal.getBoundingClientRect();
    this.drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.preventDefault();
    this.handle.setPointerCapture?.(event.pointerId);
    this.doc.addEventListener('pointermove', this.move, true);
    this.doc.addEventListener('pointerup', this.end, true);
    this.doc.addEventListener('pointercancel', this.end, true);
  };

  private readonly move = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault();
    this.position = { left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y };
    this.modal.classList.add('study-companion-quick-dragged');
    this.clamp();
  };

  readonly clamp = (): void => {
    if (!this.position || !this.win) return;
    const rect = this.modal.getBoundingClientRect();
    this.position.left = Math.max(12, Math.min(this.position.left, this.win.innerWidth - rect.width - 12));
    this.position.top = Math.max(12, Math.min(this.position.top, this.win.innerHeight - rect.height - 12));
    // Inline important also wins over the expanded modal's centered positioning.
    this.modal.style.setProperty('left', `${this.position.left}px`, 'important');
    this.modal.style.setProperty('top', `${this.position.top}px`, 'important');
  };

  private readonly end = (event: PointerEvent): void => {
    if (event.pointerId === this.drag?.pointer) this.stop();
  };

  private readonly stop = (): void => {
    const pointer = this.drag?.pointer;
    this.drag = undefined;
    this.doc.removeEventListener('pointermove', this.move, true);
    this.doc.removeEventListener('pointerup', this.end, true);
    this.doc.removeEventListener('pointercancel', this.end, true);
    if (pointer !== undefined && this.handle.hasPointerCapture?.(pointer)) this.handle.releasePointerCapture(pointer);
  };

  dispose(): void {
    this.stop();
    this.modal.removeEventListener('pointerdown', this.start);
    this.modal.removeEventListener('pointermove', this.hover);
    this.modal.removeEventListener('pointerleave', this.leave);
    this.leave();
    this.handle.removeEventListener('lostpointercapture', this.stop);
    this.win?.removeEventListener('blur', this.stop);
    this.win?.removeEventListener('resize', this.clamp);
    this.observer?.disconnect();
  }
}
