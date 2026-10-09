import type { SearchScope } from './core/learning-tools';
import { Notice, PluginSettingTab, Setting, type App, type Plugin } from 'obsidian';
import { discoverCliPath } from './adapters/cli-path';
import type { EffortLevel } from './core/contracts';
import { defaultOcrPath } from './adapters/ocr/TesseractOcr';

export type ModelProvider = 'claude' | 'codex';
export type CodexEffort = Exclude<EffortLevel, 'max'> | '';
export interface StudySettings { localOcr?: boolean; ocrPath?: string; ocrLanguages?: string; toolScope?: SearchScope; webSearch?: boolean; pdfEvidenceAgent?: boolean; provider: ModelProvider; cliPath: string; model: string; effort: EffortLevel | ''; codexCliPath: string; codexModel: string; codexEffort: CodexEffort; autoScroll: boolean; deferMath: boolean }
export function defaultCliPath(provider: ModelProvider = 'claude'): string {
  return discoverCliPath(provider);
}
export function parseSettings(value: unknown): StudySettings {
  if (value === undefined) return { toolScope: 'source', webSearch: true, pdfEvidenceAgent: false, provider: 'claude', cliPath: defaultCliPath(), model: '', effort: '', codexCliPath: defaultCliPath('codex'), codexModel: '', codexEffort: '', autoScroll: true, deferMath: true };
  if (!value || typeof value !== 'object') throw new Error('插件设置格式不正确，请保留 data.json 并检查配置。');
  const object = value as Record<string, unknown>;
  if (typeof object.cliPath !== 'string' || typeof object.model !== 'string') throw new Error('插件设置缺少 CLI 路径或模型字段。');
  const effort = object.effort === '' || object.effort === undefined || isEffort(object.effort) ? object.effort ?? '' : '';
  const toolScope = object.toolScope === 'off' || object.toolScope === 'source' || object.toolScope === 'folder' || object.toolScope === 'vault' ? object.toolScope : 'source';
  return { toolScope, webSearch: typeof object.webSearch === 'boolean' ? object.webSearch : true, pdfEvidenceAgent: object.pdfEvidenceAgent === true, provider: object.provider === 'codex' ? 'codex' : 'claude', cliPath: object.cliPath, model: object.model, effort,
    localOcr: object.localOcr === true, ocrPath: typeof object.ocrPath === 'string' ? object.ocrPath : defaultOcrPath(),
    ocrLanguages: typeof object.ocrLanguages === 'string' ? object.ocrLanguages : 'eng+chi_sim',
    codexCliPath: typeof object.codexCliPath === 'string' ? object.codexCliPath : defaultCliPath('codex'),
    codexModel: typeof object.codexModel === 'string' ? object.codexModel : '',
    codexEffort: isEffort(object.codexEffort) && object.codexEffort !== 'max' ? object.codexEffort : '',
    autoScroll: typeof object.autoScroll === 'boolean' ? object.autoScroll : true, deferMath: typeof object.deferMath === 'boolean' ? object.deferMath : true };
}
export class StudySettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private readonly settings: StudySettings, private readonly persist: (patch: Partial<StudySettings>) => Promise<void>,
    private readonly discovery: { platform: NodeJS.Platform; find: (provider: ModelProvider) => string }
      = { platform: process.platform, find: defaultCliPath }) { super(app, plugin); }
  private async save(patch: Partial<StudySettings>): Promise<void> {
    try { await this.persist(patch); }
    catch (error) { new Notice(error instanceof Error ? error.message : '设置保存失败。'); this.display(); }
  }
  display(): void {
    this.containerEl.empty();
    this.containerEl.classList.add('study-companion-settings');
    this.containerEl.createEl('h2', { text: 'Study Companion' });
    this.containerEl.createEl('h3', { text: '开始使用' });
    new Setting(this.containerEl).setName('新对话默认后端')
      .setDesc('已有 Codex 的用户请先选择 Codex。仅作为新会话的默认值，已有会话继续使用原后端。')
      .addDropdown(dropdown => dropdown.addOptions({ claude: 'Claude', codex: 'Codex' })
        .setValue(this.settings.provider).onChange(value => this.save({ provider: value as ModelProvider })));
    const windows = this.discovery.platform === 'win32';
    if (windows) this.containerEl.createEl('p', { text: 'Windows 请使用本机已登录的官方 Windows CLI，并填写实际 .exe 的绝对路径；不支持 .cmd、.bat、WSL 路径或命令参数。npm 安装的 Codex 会自动查找包内的 codex.exe。' });
    new Setting(this.containerEl).setName('重新检测 CLI 路径')
      .setDesc('安装 CLI 后可重新检测，仅补全空白路径。已有手填路径会保留；需要替换时请先清空该项。若自定义 PATH 刚修改，请重启 Obsidian 后检测。')
      .addButton(button => button.setButtonText('重新检测 CLI 路径').onClick(async () => {
        const patch: Partial<StudySettings> = {};
        if (!this.settings.cliPath.trim()) {
          const path = this.discovery.find('claude'); if (path) patch.cliPath = path;
        }
        if (!this.settings.codexCliPath.trim()) {
          const path = this.discovery.find('codex'); if (path) patch.codexCliPath = path;
        }
        if (!Object.keys(patch).length) { new Notice('未发现可补全的 CLI 路径；已有路径已保留，也可手动填写。'); return; }
        await this.save(patch); this.display();
      }));
    this.containerEl.createEl('h3', { text: '资料与检索' });
    new Setting(this.containerEl).setName('笔记检索范围')
      .setDesc('默认仅当前资料。有选区时直接回答；清除选区后可按需查当前笔记。扩展范围会增加检索和等待时间。PDF 页内检索独立处理。')
      .addDropdown(dropdown => dropdown.addOptions({ source: '仅当前资料', off: '不检索笔记', folder: '同文件夹', vault: '整个笔记库' })
        .setValue(this.settings.toolScope ?? 'source').onChange(value => this.save({ toolScope: value as SearchScope })));
    new Setting(this.containerEl).setName('按需联网（保守）')
      .setDesc('默认开启。普通解释不联网；查外部资料、核对最新信息或接着对话确认查询时，才按需使用。可关闭。')
      .addToggle(toggle => toggle.setValue(this.settings.webSearch === true).onChange(value => this.save({ webSearch: value })));
    new Setting(this.containerEl).setName('PDF 证据问答（实验）')
      .setDesc('用于学习模式的 PDF 独立问答和明确页码提问（无其他附件）。最多两页可直接提供图文；其他情况按预算检索，最多 2 张图片。课程讲解仍用文字。开启后请重新选择页码。')
      .addToggle(toggle => toggle.setValue(this.settings.pdfEvidenceAgent === true).onChange(value => this.save({ pdfEvidenceAgent: value })));
    new Setting(this.containerEl).setName('本地扫描页 OCR')
      .setDesc('发送 PDF 时识别无文字或仅有少量文字的页面，按文件版本缓存。使用本机 Tesseract，不额外调用模型；首次处理长扫描件会较慢。识别结果会明确标注。')
      .addToggle(toggle => toggle.setValue(this.settings.localOcr === true).onChange(value => this.save({ localOcr: value })));
    new Setting(this.containerEl).setName('Tesseract 路径')
      .setDesc('本地 OCR 程序的绝对路径；需要已安装对应语言包。')
      .addText(text => text.setValue(this.settings.ocrPath ?? defaultOcrPath()).onChange(value => this.save({ ocrPath: value.trim() })));
    new Setting(this.containerEl).setName('OCR 语言')
      .setDesc('默认 eng+chi_sim（英文和简体中文）；繁体中文可加 +chi_tra。仅使用本机已安装的语言。')
      .addText(text => text.setValue(this.settings.ocrLanguages ?? 'eng+chi_sim').onChange(value => this.save({ ocrLanguages: value.trim() })));
    this.containerEl.createEl('h3', { text: '阅读体验' });
    new Setting(this.containerEl).setName('流式回答自动滚动')
      .addToggle(toggle => toggle.setValue(this.settings.autoScroll).onChange(value => this.save({ autoScroll: value })));
    new Setting(this.containerEl).setName('回答结束后渲染数学公式')
      .addToggle(toggle => toggle.setValue(this.settings.deferMath).onChange(value => this.save({ deferMath: value })));
    this.containerEl.createEl('h3', { text: 'Claude' });
    new Setting(this.containerEl).setName('Claude 回答强度').setDesc('留空使用 Claude CLI 当前默认值。')
      .addDropdown(dropdown => dropdown.addOptions({ '': 'CLI 默认', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' })
        .setValue(this.settings.effort).onChange(value => this.save({ effort: value as StudySettings['effort'] })));
    this.containerEl.createEl('p', { text: '使用本机已登录的官方 CLI。检索遵守上方设置，实际读取会在回答中显示。设置保存后用于下一次请求。' });
    new Setting(this.containerEl).setName('Claude CLI 路径').setDesc('官方 Claude 可执行文件的绝对路径；不填写命令参数。')
      .addText(text => text.setPlaceholder(windows ? String.raw`C:\Users\you\.local\bin\claude.exe` : this.discovery.platform === 'darwin' ? '/Users/you/.local/bin/claude' : '/home/you/.local/bin/claude').setValue(this.settings.cliPath).onChange(value => this.save({ cliPath: value.trim() })));
    new Setting(this.containerEl).setName('Claude 模型').setDesc('留空使用 CLI 默认模型。切换模型保留当前会话。')
      .addText(text => text.setPlaceholder('使用默认模型').setValue(this.settings.model).onChange(value => this.save({ model: value.trim() })));
    this.containerEl.createEl('h3', { text: 'Codex' });
    new Setting(this.containerEl).setName('Codex CLI 路径').setDesc('官方 Codex 可执行文件的绝对路径；不填写命令参数。')
      .addText(text => text.setPlaceholder(windows ? String.raw`C:\path\to\codex.exe` : this.discovery.platform === 'darwin' ? '/opt/homebrew/bin/codex' : '/usr/local/bin/codex').setValue(this.settings.codexCliPath).onChange(value => this.save({ codexCliPath: value.trim() })));
    new Setting(this.containerEl).setName('Codex 模型').setDesc('留空使用 CLI 默认模型，也可填写你的 CLI 支持的模型名称。')
      .addText(text => text.setPlaceholder('使用默认模型').setValue(this.settings.codexModel).onChange(value => this.save({ codexModel: value.trim() })));
    new Setting(this.containerEl).setName('Codex 回答强度')
      .addDropdown(dropdown => dropdown.addOptions({ '': 'CLI 默认', low: '低', medium: '中', high: '高', xhigh: '极高' })
        .setValue(this.settings.codexEffort).onChange(value => this.save({ codexEffort: value as CodexEffort })));
    this.containerEl.createEl('h3', { text: '本地数据' });
    this.containerEl.createEl('p', { text: '新问答保存在插件目录的 history.json；设置、进度和用量保存在 data.json。升级和备份请保留这两个文件。旧版 Study Companion 文件夹里的 Markdown 历史仍可读取；清空或删除聊天不会删除已导出笔记或 CLI 自己的日志。' });
  }
}

function isEffort(value: unknown): value is EffortLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}
