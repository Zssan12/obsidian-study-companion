import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSystemAdapter } from 'obsidian';
import type { JsonHistoryPort } from '../storage/JsonStudyRepository';

/** Plugin-directory data is intentionally outside Obsidian's visible note index. */
export class PluginHistoryFile implements JsonHistoryPort {
  constructor(private readonly adapter: FileSystemAdapter, readonly path: string) {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
      || /^[A-Za-z]:/.test(path)) throw new Error('无效的插件历史路径。');
  }
  async read(): Promise<unknown> {
    if (!(await this.adapter.exists(this.path))) return undefined;
    return this.parse(await this.adapter.read(this.path));
  }
  async update(transform: (current: unknown) => unknown): Promise<void> {
    if (!(await this.adapter.exists(this.path))) {
      const data = JSON.stringify(transform(undefined));
      try {
        // Exclusive first creation: never overwrite a file created concurrently.
        await writeFile(join(this.adapter.getBasePath(), this.path), data, { flag: 'wx', mode: 0o600 });
        return;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      }
    }
    await this.adapter.process(this.path, current => JSON.stringify(transform(this.parse(current))));
  }
  private parse(text: string): unknown {
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error(`聊天历史 JSON 损坏，未覆盖原文件：${this.path}`); }
  }
}
