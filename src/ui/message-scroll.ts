export class MessageScroll {
  private following = true;
  private readonly onScroll = (): void => {
    this.following = this.element.scrollHeight - this.element.clientHeight - this.element.scrollTop < 48;
    this.notify();
  };
  constructor(private readonly element: HTMLElement, private readonly enabled: () => boolean,
    private readonly onAwayChange: (away: boolean) => void = () => {}) {
    element.addEventListener('scroll', this.onScroll, { passive: true });
  }
  update(): void {
    if (this.enabled() && this.following) this.element.scrollTop = this.element.scrollHeight;
    this.notify();
  }
  jumpToLatest(): void {
    this.following = true;
    this.element.scrollTop = this.element.scrollHeight;
    this.notify();
  }
  private notify(): void {
    this.onAwayChange(this.element.scrollHeight - this.element.clientHeight - this.element.scrollTop >= 48);
  }
  dispose(): void { this.element.removeEventListener('scroll', this.onScroll); }
}
