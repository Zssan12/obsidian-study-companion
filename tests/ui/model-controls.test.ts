// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ModelControls, type ModelChoice, type ModelPreferences } from '../../src/ui/model-controls';

function fixture(reject = false, initial: ModelChoice = { model: 'custom-model', effort: 'high' }) {
  let choice: ModelChoice = initial;
  const listeners = new Set<() => void>();
  const preferences: ModelPreferences = {
    get: () => choice,
    save: vi.fn(async next => {
      if (reject) throw new Error('Disk full');
      choice = next;
      for (const listener of listeners) listener();
    }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { preferences, listeners };
}

describe('model controls', () => {
  it('offers Codex choices before the first request and remembers the selection across new composers', async () => {
    const { preferences } = fixture(false, { provider: 'codex', model: '', effort: '', codexModel: '', codexEffort: '' });
    preferences.models = vi.fn(async () => [{ value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }]);
    const main = document.createElement('div'), quick = document.createElement('div');
    const first = new ModelControls(main, preferences, vi.fn());
    const side = new ModelControls(quick, preferences, vi.fn());
    const model = main.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
    await vi.waitFor(() => expect(Array.from(model.options).map(option => option.value)).toEqual(['', 'small', 'large']));
    expect(preferences.save).not.toHaveBeenCalled();
    expect(model.disabled).toBe(false);
    model.value = 'small'; model.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(quick.querySelector<HTMLSelectElement>('select[aria-label="模型"]')?.value).toBe('small'));
    const reopened = document.createElement('div');
    const next = new ModelControls(reopened, preferences, vi.fn());
    expect(reopened.querySelector<HTMLSelectElement>('select[aria-label="模型"]')?.value).toBe('small');
    expect(preferences.get().codexModel).toBe('small');
    first.dispose(); side.dispose(); next.dispose();
  });

  it('ignores late discovery after switching providers or disposing', async () => {
    const { preferences } = fixture(false, { provider: 'codex', model: 'sonnet', effort: '' });
    let resolve!: (models: { value: string; label: string }[]) => void;
    preferences.models = () => new Promise(done => { resolve = done; });
    const parent = document.createElement('div');
    let provider: 'claude' | 'codex' = 'codex';
    const controls = new ModelControls(parent, preferences, vi.fn(), undefined, () => provider);
    provider = 'claude'; controls.refresh();
    resolve([{ value: 'codex-model', label: 'Codex' }]);
    await Promise.resolve();
    expect(parent.querySelector<HTMLSelectElement>('select[aria-label="模型"]')?.value).toBe('sonnet');
    provider = 'codex'; controls.refresh();
    const before = parent.innerHTML;
    controls.dispose(); resolve([{ value: 'late', label: 'Late' }]);
    await Promise.resolve();
    expect(parent.innerHTML).toBe(before);
  });

  it('retains a saved custom model and exposes discovery failure instead of silently choosing another model', async () => {
    const { preferences } = fixture(false, { provider: 'codex', model: '', effort: '', codexModel: 'custom' });
    preferences.models = vi.fn(async () => { throw new Error('CLI unavailable'); });
    const parent = document.createElement('div'), error = vi.fn();
    const controls = new ModelControls(parent, preferences, error);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(parent.querySelector<HTMLSelectElement>('select[aria-label="模型"]')?.value).toBe('custom');
    expect(preferences.save).not.toHaveBeenCalled();
    controls.dispose();
  });
  it('synchronizes saved choices across composers and retains custom models', async () => {
    const { preferences, listeners } = fixture();
    const left = document.createElement('div');
    const right = document.createElement('div');
    const controls = new ModelControls(left, preferences, vi.fn());
    const other = new ModelControls(right, preferences, vi.fn());
    expect(left.querySelector('.study-companion-model-row')).not.toBeNull();
    expect(Array.from(left.querySelectorAll('.study-companion-model-label')).map(label => label.textContent)).toEqual(['模型', '推理']);
    const model = left.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
    expect(model.value).toBe('custom-model');
    expect(model.previousElementSibling?.textContent).toBe('custom-model');
    model.value = 'opus';
    model.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(right.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!.value).toBe('opus'));
    expect(preferences.save).toHaveBeenCalledWith({ model: 'opus', effort: 'high' });
    expect(right.querySelector('select[aria-label="模型"]')?.previousElementSibling?.textContent).toBe('Opus');
    controls.setBusy(true);
    expect(Array.from(left.querySelectorAll('select')).every(select => select.disabled)).toBe(true);
    controls.dispose(); other.dispose();
    expect(listeners.size).toBe(0);
  });

  it('restores persisted selection and reports a failed save', async () => {
    const { preferences } = fixture(true);
    const parent = document.createElement('div');
    const error = vi.fn();
    const controls = new ModelControls(parent, preferences, error);
    const model = parent.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
    model.value = 'sonnet';
    model.dispatchEvent(new Event('change'));
    expect(model.disabled).toBe(true);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(model.value).toBe('custom-model');
    expect(model.previousElementSibling?.textContent).toBe('custom-model');
    expect(model.disabled).toBe(false);
    controls.dispose();
  });

  it('has no provider switch and follows the conversation owner when changing displayed chats', async () => {
    const { preferences } = fixture(false, { provider: 'claude', model: 'opus', effort: 'max', codexModel: 'my-codex-model', codexEffort: 'xhigh' });
    const parent = document.createElement('div');
    let provider: 'claude' | 'codex' = 'claude';
    const controls = new ModelControls(parent, preferences, vi.fn(), undefined, () => provider);
    expect(parent.querySelector('select[aria-label="后端"]')).toBeNull();
    const model = parent.querySelector<HTMLSelectElement>('select[aria-label="模型"]')!;
    const effort = parent.querySelector<HTMLSelectElement>('select[aria-label="回答强度"]')!;
    provider = 'codex'; controls.refresh();
    await vi.waitFor(() => expect(model.value).toBe('my-codex-model'));
    expect(effort.value).toBe('xhigh');
    expect(Array.from(effort.options).map(option => option.value)).not.toContain('max');
    expect(Array.from(model.options).map(option => option.value)).toEqual(['', 'my-codex-model']);
    effort.value = 'low';
    effort.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(preferences.get().codexEffort).toBe('low'));
    provider = 'claude'; controls.refresh();
    await vi.waitFor(() => expect(model.value).toBe('opus'));
    expect(effort.value).toBe('max');
    expect(preferences.get().provider).toBe('claude');
    controls.dispose();
  });
});
