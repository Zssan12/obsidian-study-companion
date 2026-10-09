import { TFile, TFolder, normalizePath, type Vault } from 'obsidian';
import type { FilePort } from '../../core/contracts';

/** Vault-relative IO only. No direct filesystem writes or implicit overwrite of folders. */
export class VaultFilePort implements FilePort {
  constructor(private readonly vault: Vault) {}
  private path(path: string): string {
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /^[A-Za-z]:/.test(path)) throw new Error('无效的 vault 相对路径。');
    return normalizePath(path);
  }
  async exists(path: string): Promise<boolean> { return this.vault.getAbstractFileByPath(this.path(path)) !== null; }
  async read(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(this.path(path));
    if (!(file instanceof TFile)) throw new Error(`文件不存在：${path}`);
    return this.vault.read(file);
  }
  async create(path: string, text: string): Promise<void> {
    const normalized = this.path(path);
    await this.vault.create(normalized, text);
  }
  async process(path: string, transform: (current: string) => string): Promise<void> {
    const normalized = this.path(path);
    const file = this.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`文件不存在：${normalized}`);
    await this.vault.process(file, current => {
      if (this.vault.getAbstractFileByPath(normalized) !== file) throw new Error(`文件已移动或不存在：${normalized}`);
      return transform(current);
    });
  }
  async mkdir(path: string): Promise<void> {
    const parts = this.path(path).split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const entry = this.vault.getAbstractFileByPath(current);
      if (entry instanceof TFolder) continue;
      if (entry) throw new Error(`同名文件阻止建立记录目录：${current}`);
      await this.vault.createFolder(current);
    }
  }
  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = `${this.path(folder)}/`;
    return this.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix)).map(file => file.path).sort();
  }
}
