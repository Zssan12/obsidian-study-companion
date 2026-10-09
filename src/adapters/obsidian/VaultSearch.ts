import { TFile, type Vault } from 'obsidian';
import { isVaultNotePath, type VaultDocument, type VaultSearchPort } from '../../core/learning-tools';

/** Only visible Markdown source notes; generated records and caches are excluded. */
export class VaultSearch implements VaultSearchPort {
  constructor(private readonly vault: Vault) {}
  list(): VaultDocument[] {
    return this.vault.getMarkdownFiles().filter(f => isVaultNotePath(f.path))
      .map(f => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }
  async read(path: string): Promise<string> {
    if (!isVaultNotePath(path)) throw new Error('只允许读取笔记库中的 Markdown 资料。');
    const file = this.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('笔记已移动或不存在。');
    if (file.stat.size > 512_000) throw new Error('单份笔记超过 512 KB 检索上限，请显式附加。');
    const text = await this.vault.read(file);
    if (text.length > 512_000) throw new Error('笔记读取后超过检索上限。');
    return text;
  }
}
