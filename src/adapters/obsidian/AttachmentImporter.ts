import { createHash } from 'node:crypto';
import { TFile, type Vault } from 'obsidian';
import type { SourceContext } from '../../core/contracts';
import { assertImages, type EvidenceImage } from '../../core/pdf-agent';

const DIRECTORY = 'Study Companion Attachments';
export const ATTACHMENT_ACCEPT = '.pdf,.md,.txt,.csv,.json,.png,.jpg,.jpeg,.webp';
const digest = (data: ArrayBuffer): string => createHash('sha256').update(new Uint8Array(data)).digest('hex');

export class AttachmentImporter {
  constructor(private readonly vault: Vault, private readonly choosePdf: (file: TFile) => Promise<SourceContext | null>) {}

  async importFile(file: File): Promise<SourceContext | null> {
    const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    if (!ATTACHMENT_ACCEPT.split(',').includes(`.${extension}`)) throw new Error(`${file.name}：暂不支持此格式，请使用 PDF、MD、TXT、CSV、JSON 或 PNG/JPEG/WebP 图片。`);
    const image = ['png', 'jpg', 'jpeg', 'webp'].includes(extension);
    const limit = extension === 'pdf' ? 32 * 1024 * 1024 : image ? 10 * 1024 * 1024 : 48_000;
    if (!file.size || file.size > limit) throw new Error(`${file.name}：文件为空或超过大小限制（PDF 32 MB、图片 10 MB、文本 48 KB）。`);
    let bytes = await file.arrayBuffer();
    if (image) bytes = await normalizeImage(bytes, file.type);
    const hash = digest(bytes);
    const name = Array.from(file.name, char => char.charCodeAt(0) < 32 ? '_' : char).join('').replace(/[\\/:*?"<>|]/gu, '_').slice(-100);
    const path = `${DIRECTORY}/${hash.slice(0, 16)}-${image ? name.replace(/\.[^.]+$/u, '.png') : name}`;
    let context: SourceContext = { sourcePath: path, sourceName: file.name.slice(0, 150), selectedText: '', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
    if (image) {
      context = { ...context, image: { sha256: hash }, selectedText: '用户附加的图片；实际内容由本轮图片输入提供。' };
      assertImages([{ data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png', label: context.sourceName }]);
    } else if (extension !== 'pdf') {
      try { context.selectedText = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error(`${file.name}：请先转换为 UTF-8 文本。`); }
      if (context.selectedText.includes('\u0000')) throw new Error(`${file.name}：不是可读取的文本文件。`);
      if (!context.selectedText.trim() || context.selectedText.length > 12_000) throw new Error(`${file.name}：文本为空或超过 12000 字符，请缩小范围。`);
      const lines = context.selectedText.split('\n');
      context.to = { line: lines.length - 1, ch: lines.at(-1)!.length };
    }
    if (!this.vault.getAbstractFileByPath(DIRECTORY)) {
      try { await this.vault.createFolder(DIRECTORY); }
      catch (error) { if (!this.vault.getAbstractFileByPath(DIRECTORY)) throw error; }
    }
    let target = this.vault.getAbstractFileByPath(path);
    if (target instanceof TFile) {
      if (digest(await this.vault.readBinary(target)) !== hash) throw new Error('本地附件副本已改变，请重命名文件后重新添加。');
    } else if (target) throw new Error('附件路径被文件夹占用。');
    else target = await this.vault.createBinary(path, bytes);
    return extension === 'pdf' ? this.choosePdf(target as TFile) : context;
  }

  preview(source: SourceContext): string | undefined {
    if (!source.image || !source.sourcePath.startsWith(`${DIRECTORY}/`)) return undefined;
    const file = this.vault.getAbstractFileByPath(source.sourcePath);
    return file instanceof TFile ? this.vault.getResourcePath(file) : undefined;
  }

  async readImage(source: SourceContext): Promise<EvidenceImage> {
    if (!source.image || !source.sourcePath.startsWith(`${DIRECTORY}/`) || source.sourcePath.split('/').includes('..') || source.sourcePath.includes('\\')) throw new Error('图片必须来自本地附件目录。');
    const file = this.vault.getAbstractFileByPath(source.sourcePath);
    if (!(file instanceof TFile) || file.stat.size > 3_000_000) throw new Error('图片已移动、删除或超过大小限制，请重新添加。');
    const bytes = await this.vault.readBinary(file);
    if (digest(bytes) !== source.image.sha256) throw new Error('图片已改变，请重新添加，避免回答使用错误版本。');
    const image: EvidenceImage = { data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png', label: source.sourceName.slice(0, 150) };
    assertImages([image]); return image;
  }
}

async function normalizeImage(bytes: ArrayBuffer, type: string): Promise<ArrayBuffer> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('图片尺寸过大，请缩小后再添加。');
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const drawing = canvas.getContext('2d');
    if (!drawing) throw new Error('图片处理不可用。');
    drawing.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片转换失败。')), 'image/png'));
    if (blob.size > 3_000_000) throw new Error('图片转换后仍超过 3 MB，请缩小后添加。');
    return blob.arrayBuffer();
  } finally { bitmap.close(); }
}
