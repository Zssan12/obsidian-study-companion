import { execFile, type ExecFileException } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Preserve the installed CLI model metadata but remove file/tool capabilities. */
export function restrictCatalog(value: unknown, webAccess = false): { models: Record<string, unknown>[] } {
  const models = (value as { models?: unknown } | null)?.models;
  if (!Array.isArray(models) || !models.length) throw new Error('Codex model catalog unavailable; update the CLI.');
  return { models: models.map(value => {
    if (!value || typeof value !== 'object' || typeof value.slug !== 'string') throw new Error('Invalid Codex model catalog.');
    return { ...value, apply_patch_tool_type: null, experimental_supported_tools: [],
      supports_search_tool: webAccess ? value.supports_search_tool : false };
  }) };
}

export async function readBundledCatalog(cliPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(cliPath, ['debug', 'models', '--bundled'], { cwd, env, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(catalogError(error, stderr)));
      else resolve(stdout);
    });
  });
  return JSON.parse(raw) as unknown;
}

export async function prepareToolCatalog(cliPath: string, cwd: string, env: NodeJS.ProcessEnv, model?: string, webAccess = false): Promise<string> {
  const catalog = restrictCatalog(await readBundledCatalog(cliPath, cwd, env), webAccess);
  if (model && !catalog.models.some(entry => entry.slug === model)) throw new Error('Codex 模型不在本机 CLI 内置目录中，请更新 CLI 或使用默认模型。');
  const path = join(cwd, `study-models-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(catalog), { mode: 0o600 });
  return path;
}

function catalogError(error: ExecFileException, stderr: string): string {
  // Classify startup diagnostics without persisting raw stderr or user config.
  if (error.code === 'ENOENT') return '找不到 Codex CLI，请检查插件设置中的 Codex CLI 路径。';
  if (error.code === 'EACCES') return 'Codex CLI 没有执行权限，请检查安装及文件权限。';
  if (/\bnode\b.*(?:no such file|not found|not recognized)/i.test(stderr)) return 'Codex CLI 启动失败：找不到 Node.js。请检查 Node.js 安装及 Codex CLI 路径。';
  if (error.killed || error.signal === 'SIGTERM') return '读取 Codex 本机模型目录超时，请检查 CLI 能否正常启动后重试。';
  if (/(?:unrecognized|unknown|unexpected|invalid)[^\n]*(?:models|bundled)/i.test(stderr)) return '当前 Codex CLI 不支持读取内置模型目录，请更新 CLI。';
  return `读取 Codex 本机模型目录失败（退出码 ${String(error.code ?? '未知')}）。请在终端运行 codex debug models --bundled 检查安装。`;
}
