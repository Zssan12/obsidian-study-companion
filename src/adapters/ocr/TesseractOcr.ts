import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { LocalOcrPort, OcrText } from '../../core/ocr';
import { assertImages, type EvidenceImage } from '../../core/pdf-agent';

export function defaultOcrPath(): string {
  for (const folder of ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean)) {
    const path = join(folder, process.platform === 'win32' ? 'tesseract.exe' : 'tesseract');
    try { accessSync(path, constants.X_OK); return path; } catch { /* Check the next local installation. */ }
  }
  return '';
}

/** No shell, temporary image files, network or model calls. PNG travels over stdin. */
export class TesseractOcr implements LocalOcrPort {
  readonly configuration: string;
  constructor(private readonly path: string, private readonly languages = 'eng+chi_sim') {
    if (!isAbsolute(path)) throw new Error('请在设置中填写本机 Tesseract 的绝对路径，再使用本地 OCR。');
    if (!/^[a-z_]{2,20}(?:\+[a-z_]{2,20}){0,3}$/u.test(languages)) throw new Error('OCR 语言无效，例如 eng+chi_sim。');
    this.configuration = JSON.stringify(['tesseract-tsv-v1', path, languages]);
  }
  async recognize(image: EvidenceImage, signal: AbortSignal): Promise<OcrText> {
    if (signal.aborted) throw new Error('OCR 已取消。');
    assertImages([image]);
    const tsv = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.path, ['stdin', 'stdout', '-l', this.languages, '--psm', '3', 'tsv'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let output = ''; let bytes = 0; let failure: Error | undefined;
      const stop = (message: string): void => { failure ??= new Error(message); child.kill('SIGKILL'); };
      const abort = (): void => stop('OCR 已取消。');
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => stop('单页 OCR 超过 30 秒，请缩小页面或检查本地 OCR 安装。'), 30_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { bytes += Buffer.byteLength(chunk); if (bytes > 2_000_000) stop('OCR 输出超出单页预算。'); else output += chunk; });
      // Do not retain stderr: it can contain local installation paths. Report an actionable failure.
      child.stderr.resume();
      child.stdin.on('error', () => { failure ??= new Error('无法向 OCR 引擎传入页面。'); });
      child.on('error', () => { failure ??= new Error('无法启动本地 OCR，请检查 Tesseract 路径。'); });
      child.on('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (failure || code !== 0) reject(failure ?? new Error('OCR 未完成，请检查 Tesseract 及所选语言包。'));
        else resolve(output);
      });
      if (signal.aborted) abort();
      child.stdin.end(Buffer.from(image.data, 'base64'));
    });
    return parseTesseractTsv(tsv);
  }
}

export function parseTesseractTsv(tsv: string): OcrText {
  const lines = new Map<string, string[]>(); let confidence = 0; let words = 0;
  if (!tsv.startsWith('level\tpage_num\t')) throw new Error('OCR 返回格式无效。');
  for (const row of tsv.split(/\r?\n/u).slice(1)) {
    const cells = row.split('\t');
    if (cells[0] !== '5' || cells.length < 12) continue;
    const text = cells.slice(11).join(' ').trim(); const score = Number(cells[10]);
    if (!text || !Number.isFinite(score) || score < 0 || score > 100) continue;
    const key = cells.slice(1, 5).join(':');
    const line = lines.get(key) ?? []; line.push(text); lines.set(key, line);
    confidence += score; words++;
  }
  const text = [...lines.values()].map(words => words.join(' ')).join('\n');
  if (text.length > 60_000) throw new Error('OCR 文字超出单页预算。');
  return { text, confidence: words ? confidence / words : 0 };
}
