import type { EffortLevel } from '../core/contracts';

export type ModelProvider = 'claude' | 'codex';
export type CodexEffort = Exclude<EffortLevel, 'max'> | '';
export interface ModelChoice { provider?: ModelProvider; model: string; effort: EffortLevel | ''; codexModel?: string; codexEffort?: CodexEffort }
export interface ModelPreferences {
  get(): ModelChoice;
  save(choice: ModelChoice): Promise<void>;
  subscribe(listener: () => void): () => void;
  models?(provider: ModelProvider): Promise<readonly { value: string; label: string }[]>;
}

export class ModelControls {
  private readonly model: HTMLSelectElement;
  private readonly effort: HTMLSelectElement;
  private readonly unsubscribe: () => void;
  private readonly selectedLabels = new Map<HTMLSelectElement, HTMLSpanElement>();
  private saving = false;
  private busy = false;
  private renderedProvider?: ModelProvider;
  private codexModels: readonly { value: string; label: string }[] = [];
  private loadingModels = false;
  private modelLoad = 0;

  constructor(parent: HTMLElement, private readonly preferences: ModelPreferences, private readonly onError: (error: unknown) => void, leadingControl?: HTMLElement, private readonly boundProvider: () => ModelProvider | undefined = () => preferences.get().provider) {
    const container = parent.ownerDocument.createElement('div');
    container.className = 'study-companion-model-row';
    parent.appendChild(container);
    if (leadingControl) container.appendChild(leadingControl);
    this.model = this.select(container, '模型', {});
    this.effort = this.select(container, '回答强度', { '': '默认强度', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' });
    this.unsubscribe = preferences.subscribe(() => { this.render(); void this.loadModels(); });
    this.render();
    void this.loadModels();
  }

  private select(parent: HTMLElement, label: string, values: Record<string, string>): HTMLSelectElement {
    const field = parent.ownerDocument.createElement('label');
    field.className = 'study-companion-model-field';
    const caption = parent.ownerDocument.createElement('span');
    caption.className = 'study-companion-model-label';
    caption.textContent = label === '回答强度' ? '推理' : label;
    caption.hidden = label !== '回答强度';
    field.appendChild(caption);
    const select = parent.ownerDocument.createElement('select');
    select.setAttribute('aria-label', label);
    select.title = label;
    for (const [value, text] of Object.entries(values)) select.add(new Option(text, value));
    select.addEventListener('change', () => { void this.save(); });
    // A text-sized visual label avoids native select width following its longest option
    // or host theme defaults. The native control still owns focus and the picker.
    const picker = parent.ownerDocument.createElement('span');
    picker.className = 'study-companion-model-picker';
    const selected = parent.ownerDocument.createElement('span');
    selected.className = 'study-companion-model-value';
    selected.setAttribute('aria-hidden', 'true');
    this.selectedLabels.set(select, selected);
    picker.append(selected, select);
    field.appendChild(picker);
    parent.appendChild(field);
    return select;
  }

  private async save(): Promise<void> {
    const current = this.preferences.get();
    const provider = this.boundProvider() ?? 'claude';
    const choice: ModelChoice = { ...current };
    if (provider === 'codex') {
      choice.codexModel = this.model.value;
      choice.codexEffort = this.effort.value as CodexEffort;
    } else {
      choice.model = this.model.value;
      choice.effort = this.effort.value as ModelChoice['effort'];
    }
    this.renderLabels();
    this.saving = true;
    this.renderDisabled();
    try { await this.preferences.save(choice); }
    catch (error) { this.onError(error); }
    finally { this.saving = false; this.render(); }
  }

  private render(): void {
    const choice = this.preferences.get();
    const provider = this.boundProvider() ?? 'claude';
    this.renderedProvider = provider;
    this.model.replaceChildren();
    const models = provider === 'claude' ? { '': '默认模型', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
      : { '': this.loadingModels && !this.codexModels.length ? '读取模型列表…' : 'CLI 默认' };
    for (const [value, text] of Object.entries(models)) this.model.add(new Option(text, value));
    if (provider === 'codex') for (const option of this.codexModels) this.model.add(new Option(option.label, option.value));
    const model = provider === 'codex' ? choice.codexModel ?? '' : choice.model;
    if (!Array.from(this.model.options).some(item => item.value === model)) {
      const option = new Option(model, model);
      this.model.add(option);
    }
    this.model.value = model;
    this.effort.replaceChildren();
    const efforts: Record<string, string> = { '': '默认', low: '低', medium: '中', high: '高', xhigh: '极高' };
    if (provider === 'claude') efforts.max = '最大';
    for (const [value, text] of Object.entries(efforts)) this.effort.add(new Option(text, value));
    this.effort.value = provider === 'codex' ? choice.codexEffort ?? '' : choice.effort;
    this.renderLabels();
    this.renderDisabled();
  }

  private renderLabels(): void {
    for (const [select, label] of this.selectedLabels) {
      const text = select.selectedOptions[0]?.textContent ?? '';
      label.textContent = text;
      select.title = `${this.renderedProvider === 'codex' ? 'Codex' : 'Claude'} · ${select.getAttribute('aria-label')}：${text}`;
    }
  }

  private renderDisabled(): void { this.model.disabled = this.effort.disabled = this.busy || this.saving; }
  private async loadModels(): Promise<void> {
    const revision = ++this.modelLoad;
    if ((this.boundProvider() ?? 'claude') !== 'codex' || !this.preferences.models) return;
    this.loadingModels = true;
    this.render();
    try {
      const models = await this.preferences.models('codex');
      if (revision === this.modelLoad) this.codexModels = models;
    } catch (error) { if (revision === this.modelLoad) { this.codexModels = []; this.onError(error); } }
    finally { if (revision === this.modelLoad) { this.loadingModels = false; this.render(); } }
  }
  refresh(): void { if (this.renderedProvider !== (this.boundProvider() ?? 'claude')) { this.render(); void this.loadModels(); } }
  setBusy(busy: boolean): void { this.busy = busy; this.renderDisabled(); }
  dispose(): void { this.modelLoad++; this.unsubscribe(); }
}
