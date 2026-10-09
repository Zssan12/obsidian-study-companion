import { resizeComposer } from './chat-interactions';

export const PROMPT_TEMPLATES = [
  { command: '/总结', text: '请总结本次提供的资料：按章节或主题梳理内容，概括核心结论与依据，解释关键概念，并列出未覆盖或无法识别的部分。PDF 请为关键结论标注来源页码。' },
  { command: '/解释', text: '请解释这个概念：先说核心含义，再说明适用条件和容易误解的地方。' },
  { command: '/举例', text: '请用一个具体例子解释，再给出一个反例，说明两者的区别。' },
  { command: '/对比', text: '请对比这些概念的目标、前提、关键区别和适用场景。' },
  { command: '/推导', text: '请从前提开始逐步推导，说明每一步依据和公式中符号的含义，不省略关键步骤。' },
] as const;

export class PromptTemplates {
  private readonly menu: HTMLElement;
  private matches: (typeof PROMPT_TEMPLATES)[number][] = [];
  private index = 0;
  readonly refresh = (): void => {
    const query = this.input.value;
    this.matches = /^\/\S*$/.test(query) ? PROMPT_TEMPLATES.filter(item => item.command.startsWith(query)) : [];
    this.index = 0;
    this.render();
  };
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.isComposing || this.menu.hidden || !this.matches.length) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key) || event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { this.menu.hidden = true; return; }
    if (event.key === 'Enter') { this.choose(this.index); return; }
    this.index = (this.index + (event.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length;
    this.render();
  };
  constructor(private readonly input: HTMLTextAreaElement) {
    this.menu = input.ownerDocument.createElement('div');
    this.menu.className = 'study-companion-template-menu';
    this.menu.setAttribute('role', 'group');
    this.menu.setAttribute('aria-label', '快捷提问模板');
    input.before(this.menu);
    input.addEventListener('input', this.refresh);
    input.addEventListener('keydown', this.keydown, true);
    this.refresh();
  }
  private render(): void {
    this.menu.replaceChildren();
    this.menu.hidden = !this.matches.length;
    this.matches.forEach((item, index) => {
      const button = this.input.ownerDocument.createElement('button');
      button.type = 'button';
      button.textContent = item.command;
      button.title = item.text;
      button.classList.toggle('is-selected', index === this.index);
      button.addEventListener('click', () => this.choose(index));
      this.menu.appendChild(button);
    });
  }
  private choose(index: number): void {
    this.input.value = this.matches[index]!.text;
    this.input.dispatchEvent(new this.input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
    resizeComposer(this.input);
    this.input.focus();
  }
  dispose(): void {
    this.input.removeEventListener('input', this.refresh);
    this.input.removeEventListener('keydown', this.keydown, true);
    this.menu.remove();
  }
}
