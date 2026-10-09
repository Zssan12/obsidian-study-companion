import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { TFile, type Vault } from 'obsidian';
import { AttachmentImporter } from '../../src/adapters/obsidian/AttachmentImporter';
vi.mock('obsidian', () => ({ TFile: class {} }));
function setup() {
  const files = new Map<string, { file: TFile; bytes: ArrayBuffer }>();
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path)?.file ?? (folders.has(path) ? {} : null),
    createFolder: vi.fn(async (path: string) => { folders.add(path); }),
    createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
      const file = Object.assign(new TFile(), { path, stat: { size: bytes.byteLength } });
      files.set(path, { file, bytes }); return file;
    }),
    readBinary: vi.fn(async (file: TFile) => files.get(file.path)!.bytes),
    getResourcePath: (file: TFile) => `app://test/${file.path}`,
  };
  const choosePdf = vi.fn(async () => null);
  return { importer: new AttachmentImporter(vault as unknown as Vault, choosePdf), vault, files, choosePdf };
}
const file = (name: string, text: string): File => new File([text], name);
it('imports bounded text as an attachment, preserving its full content and reusing the local copy', async () => {
  const test = setup(); const input = file('lesson.txt', '第一行\n第二行');
  const source = await test.importer.importFile(input);
  expect(source).toMatchObject({ sourceName: 'lesson.txt', selectedText: '第一行\n第二行', to: { line: 1, ch: 3 } });
  expect(source!.sourcePath).toMatch(/^Study Companion Attachments\//u);
  expect(await test.importer.importFile(input)).toEqual(source);
  expect(test.vault.createBinary).toHaveBeenCalledOnce();
});
it('rejects unsupported, oversized, blank and invalid text before creating files', async () => {
  const test = setup();
  for (const input of [file('a.docx', 'binary'), file('a.txt', 'a'.repeat(12_001)), file('a.txt', '  '), file('a.txt', '\u0000')]) {
    await expect(test.importer.importFile(input)).rejects.toThrow();
  }
  expect(test.vault.createBinary).not.toHaveBeenCalled();
});
it('routes dropped PDFs through explicit page selection and handles cancel without attaching', async () => {
  const test = setup();
  expect(await test.importer.importFile(file('lesson.pdf', '%PDF-1.7'))).toBeNull();
  expect(test.choosePdf).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining('lesson.pdf') }));
});
it('reads only unchanged local PNG references and rejects missing files and traversal', async () => {
  const test = setup(); const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAA==', 'base64')).buffer;
  const path = 'Study Companion Attachments/image.png';
  await test.vault.createBinary(path, bytes);
  const source = { sourcePath: path, sourceName: 'image.png', selectedText: 'image', before: '', after: '', from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 }, image: { sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex') } };
  expect(await test.importer.readImage(source)).toMatchObject({ mimeType: 'image/png', label: 'image.png' });
  await expect(test.importer.readImage({ ...source, image: { sha256: 'a'.repeat(64) } })).rejects.toThrow('改变');
  await expect(test.importer.readImage({ ...source, sourcePath: 'Study Companion Attachments/../secret.png' })).rejects.toThrow('目录');
  await expect(test.importer.readImage({ ...source, sourcePath: 'Study Companion Attachments/missing.png' })).rejects.toThrow('移动');
});

it('normalizes an imported image, persists a hash reference and makes a preview available', async () => {
  const test = setup();
  const bytes = Uint8Array.from(Buffer.from('iVBORw0KGgoAAA==', 'base64')).buffer;
  const bitmap = { width: 4000, height: 2000, close: vi.fn() };
  const drawImage = vi.fn();
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: (callback: (blob: Blob) => void) => callback(new Blob([bytes])) };
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  vi.stubGlobal('document', { createElement: () => canvas });
  try {
    const source = await test.importer.importFile(file('diagram.jpg', 'image bytes'));
    expect(canvas.width).toBe(2048); expect(canvas.height).toBe(1024);
    expect(drawImage).toHaveBeenCalledOnce(); expect(bitmap.close).toHaveBeenCalledOnce();
    expect(source!.image?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(source!.sourcePath).toMatch(/\.png$/u);
    expect(test.importer.preview(source!)).toContain('app://test/');
    expect(await test.importer.readImage(source!)).toMatchObject({ mimeType: 'image/png' });
    expect(JSON.stringify(source)).not.toContain('iVBOR');
  } finally { vi.unstubAllGlobals(); }
});
