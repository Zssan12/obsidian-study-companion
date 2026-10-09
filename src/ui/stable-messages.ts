export interface StableMessageRenderer<T> {
  key(item: T): string;
  create(item: T): HTMLElement;
  update(element: HTMLElement, item: T): void;
}

/** Keeps keyed message roots mounted and only moves nodes when their order changes. */
export class StableMessages {
  private readonly elements = new Map<string, HTMLElement>();

  constructor(private readonly container: HTMLElement) {}

  reconcile<T>(items: readonly T[], renderer: StableMessageRenderer<T>): ReadonlySet<string> {
    const keyed = items.map(item => ({ item, key: renderer.key(item) }));
    const keys = new Set(keyed.map(entry => entry.key));
    if (keys.size !== keyed.length) throw new Error('Stable message keys must be unique.');

    let nextNode: ChildNode | null = this.container.firstChild;
    for (const { item, key } of keyed) {
      let element = this.elements.get(key);
      if (!element) {
        element = renderer.create(item);
        this.elements.set(key, element);
      }
      if (element !== nextNode) this.container.insertBefore(element, nextNode);
      renderer.update(element, item);
      nextNode = element.nextSibling;
    }

    for (const [key, element] of this.elements) {
      if (keys.has(key)) continue;
      element.remove();
      this.elements.delete(key);
    }
    return keys;
  }

  dispose(): void {
    this.elements.clear();
  }
}
