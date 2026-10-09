import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Plugin } from 'obsidian';

const ui = vi.hoisted(() => ({ rows: [] as { name: string; desc?: string; value?: string | boolean; placeholder?: string;
  options?: Record<string, string>; change?: (value: string) => Promise<void>; click?: () => Promise<void> }[], texts: [] as string[] }));
vi.mock('obsidian', () => ({
  Notice: class {},
  PluginSettingTab: class {
    containerEl = { empty: () => { ui.rows.length = 0; ui.texts.length = 0; },
      classList: { add: () => {} }, createEl: (_tag: string, options: { text: string }) => { ui.texts.push(options.text); } };
  },
  Setting: class {
    row: typeof ui.rows[number] = { name: '' };
    constructor() { ui.rows.push(this.row); }
    setName(name: string) { this.row.name = name; return this; }
    setDesc(desc: string) { this.row.desc = desc; return this; }
    setValue(value: string | boolean) { this.row.value = value; return this; }
    setPlaceholder(value: string) { this.row.placeholder = value; return this; }
    addOptions(options: Record<string, string>) { this.row.options = options; return this; }
    onChange(callback: (value: string) => Promise<void>) { this.row.change = callback; return this; }
    onClick(callback: () => Promise<void>) { this.row.click = callback; return this; }
    setButtonText(_text: string) { return this; }
    addDropdown(callback: (component: this) => void) { callback(this); return this; }
    addToggle(callback: (component: this) => void) { callback(this); return this; }
    addText(callback: (component: this) => void) { callback(this); return this; }
    addButton(callback: (component: this) => void) { callback(this); return this; }
  },
}));

import { parseSettings, StudySettingTab, type StudySettings } from '../../src/settings';

beforeEach(() => { ui.rows.length = 0; ui.texts.length = 0; });

describe('provider settings', () => {
  it('keeps existing Claude preferences when migrating old settings', () => {
    const settings = parseSettings({ cliPath: '/cli/claude', model: 'custom', effort: 'max' });
    expect(settings).toMatchObject({ provider: 'claude', cliPath: '/cli/claude', model: 'custom', effort: 'max', codexModel: '', codexEffort: '' });
  });

  it('preserves Codex preferences independently from Claude', () => {
    const settings = parseSettings({ provider: 'codex', cliPath: '/cli/claude', model: 'opus', effort: 'max', codexCliPath: '/cli/codex', codexModel: 'custom-codex', codexEffort: 'xhigh' });
    expect(settings).toMatchObject({ provider: 'codex', model: 'opus', effort: 'max', codexCliPath: '/cli/codex', codexModel: 'custom-codex', codexEffort: 'xhigh' });
  });

  it('falls back to CLI default for unsupported Codex reasoning', () => {
    expect(parseSettings({ cliPath: '', model: '', codexEffort: 'max' }).codexEffort).toBe('');
  });
});

it('defaults to conservative automatic web and respects saved retrieval choices', () => {
  expect(parseSettings(undefined)).toMatchObject({ toolScope: 'source', webSearch: true });
  expect(parseSettings({ cliPath: '/claude', model: '' })).toMatchObject({ toolScope: 'source', webSearch: true });
  for (const toolScope of ['off', 'source', 'folder', 'vault']) {
    expect(parseSettings({ cliPath: '/claude', model: '', toolScope, webSearch: false }))
      .toMatchObject({ toolScope, webSearch: false });
    expect(parseSettings({ cliPath: '/claude', model: '', toolScope, webSearch: true }))
      .toMatchObject({ toolScope, webSearch: true });
  }
  expect(parseSettings({ cliPath: '/claude', model: '', toolScope: 'invalid', webSearch: 'true' }))
    .toMatchObject({ toolScope: 'source', webSearch: true });
});

function showSettings(overrides: Partial<StudySettings> = {}, platform: NodeJS.Platform = 'win32') {
  const settings = parseSettings({ cliPath: '', model: '', codexCliPath: '', ...overrides });
  const persist = vi.fn(async (patch: Partial<StudySettings>) => { Object.assign(settings, patch); });
  const find = vi.fn((provider: 'claude' | 'codex') => provider === 'codex' ? String.raw`C:\Users\张 三\工具\codex.exe` : '');
  const tab = new StudySettingTab({} as App, {} as Plugin, settings, persist, { platform, find });
  tab.display();
  return { settings, persist, find, tab };
}
const row = (name: string) => ui.rows.find(item => item.name === name)!;

it('offers an explicit new-conversation backend choice without changing old defaults or other preferences', async () => {
  const { settings, persist } = showSettings({ codexModel: 'my-codex', model: 'my-claude' });
  expect(row('新对话默认后端').value).toBe('claude');
  expect(row('新对话默认后端').desc).toContain('已有会话继续使用原后端');
  expect(row('新对话默认后端').options).toEqual({ claude: 'Claude', codex: 'Codex' });
  await row('新对话默认后端').change!('codex');
  expect(persist).toHaveBeenCalledExactlyOnceWith({ provider: 'codex' });
  expect(settings).toMatchObject({ provider: 'codex', codexModel: 'my-codex', model: 'my-claude' });
  expect(parseSettings(undefined).provider).toBe('claude');
});

it('redetects newly installed CLI into empty fields only and refreshes the displayed value', async () => {
  const { settings, persist, find } = showSettings({ cliPath: 'C:/custom/claude.exe', provider: 'codex' });
  expect(find).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  await row('重新检测 CLI 路径').click!();
  expect(find).toHaveBeenCalledExactlyOnceWith('codex');
  expect(persist).toHaveBeenCalledExactlyOnceWith({ codexCliPath: String.raw`C:\Users\张 三\工具\codex.exe` });
  expect(row('Codex CLI 路径').value).toBe(settings.codexCliPath);
  expect(settings).toMatchObject({ cliPath: 'C:/custom/claude.exe', provider: 'codex' });
});

it('preserves saved and manually edited CLI paths on repeated detection', async () => {
  const { settings, persist, find } = showSettings({ cliPath: 'C:/claude.exe', codexCliPath: 'D:/codex.exe', provider: 'codex' });
  await row('Codex CLI 路径').change!('  E:/中文 空格/codex.exe  ');
  persist.mockClear();
  await row('重新检测 CLI 路径').click!();
  expect(find).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(settings.codexCliPath).toBe('E:/中文 空格/codex.exe');
});

it('does not save empty discoveries when no CLI is installed', async () => {
  const { persist, find } = showSettings(); find.mockReturnValue('');
  await row('重新检测 CLI 路径').click!();
  expect(persist).not.toHaveBeenCalled();
});

it('keeps blank paths after a failed save', async () => {
  const { settings, persist } = showSettings(); persist.mockRejectedValueOnce(new Error('disk full'));
  await row('重新检测 CLI 路径').click!();
  expect(settings.codexCliPath).toBe(''); expect(row('Codex CLI 路径').value).toBe('');
});

it.each(['win32', 'darwin', 'linux'] as const)('uses %s path examples and Windows setup guidance', platform => {
  showSettings({}, platform);
  if (platform === 'win32') {
    expect(row('Claude CLI 路径').placeholder).toBe(String.raw`C:\Users\you\.local\bin\claude.exe`);
    expect(row('Codex CLI 路径').placeholder).toBe(String.raw`C:\path\to\codex.exe`);
    expect(ui.texts.join(' ')).toContain('不支持 .cmd、.bat、WSL');
  } else {
    expect(row('Codex CLI 路径').placeholder).toBe(platform === 'darwin' ? '/opt/homebrew/bin/codex' : '/usr/local/bin/codex');
    expect(row('Claude CLI 路径').placeholder).toBe(platform === 'darwin' ? '/Users/you/.local/bin/claude' : '/home/you/.local/bin/claude');
  }
});
