import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { codexEnvironment } from './environment';
import { readBundledCatalog, restrictCatalog } from './tool-policy';

export interface CodexModelOption { value: string; label: string }

export function modelOptions(raw: unknown): CodexModelOption[] {
  const seen = new Set<string>();
  const models = restrictCatalog(raw).models
    .filter(model => model.visibility === 'list')
    .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999));
  const options: CodexModelOption[] = [];
  for (const model of models) {
    const value = model.slug as string;
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: typeof model.display_name === 'string' && model.display_name ? model.display_name : value });
  }
  if (!options.length) throw new Error('Codex 本机目录没有可显示的模型，请检查 CLI 安装。');
  return options;
}

/** Shared local discovery; no login, remote refresh, conversation or inference. */
export class CodexModelCatalog {
  private readonly cache = new Map<string, Promise<CodexModelOption[]>>();
  private directory?: Promise<string>;

  constructor(private readonly read = readBundledCatalog) {}

  list(cliPath: string): Promise<CodexModelOption[]> {
    if (!isAbsolute(cliPath)) return Promise.reject(new Error('Codex CLI 路径必须是绝对路径。'));
    const cached = this.cache.get(cliPath);
    if (cached) return cached;
    this.directory ??= mkdtemp(join(tmpdir(), 'study-companion-model-list-'));
    const pending = this.directory.then(cwd => this.read(cliPath, cwd, codexEnvironment(cliPath)))
      .then(modelOptions).catch(error => { this.cache.delete(cliPath); throw error; });
    this.cache.set(cliPath, pending);
    return pending;
  }
}
