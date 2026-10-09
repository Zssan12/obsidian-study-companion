import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { setTimeout, clearTimeout } from 'node:timers';
import { isAllowedItemType } from './protocol-policy';

/** Owns one protocol reader for the entire lifetime of an ephemeral thread. */
export class AppServerConnection {
  readonly completion: Promise<number | null>;
  readonly messages: AsyncIterableIterator<string>;
  readonly lines: Interface;
  closed = false;
  invalidated = false;
  busy = true;
  processError?: Error;
  protocolViolation?: string;
  threadId?: string;
  previousTurnId?: string;
  defaultModel?: string;
  defaultEffort?: string;
  lastModel?: string;
  lastEffort?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;

  constructor(readonly child: ChildProcessWithoutNullStreams, readonly cliPath: string, readonly cwd: string, private readonly onClose: () => void, webAccess = false) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.messages = this.lines[Symbol.asyncIterator]();
    this.completion = new Promise(resolve => {
      child.once('error', (error: Error) => { this.processError = error; this.finish(); child.stdout.destroy(); resolve(null); });
      child.once('close', (code: number | null) => { this.finish(); resolve(code); });
    });
    child.stderr.resume();
    child.stdin.on('error', (error: Error) => { this.processError = error; this.stop(); });
    // Observe policy failures immediately even if they were queued just after done.
    // Busy turns report the structured failure; idle connections are invalidated now.
    this.lines.on('line', (line: string) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as { id?: unknown; method?: string; error?: unknown; params?: { item?: { type?: string } } };
        const toolItem = (event.method === 'item/started' || event.method === 'item/completed')
          && !isAllowedItemType(event.params?.item?.type, webAccess);
        if ((event.id !== undefined && event.method) || toolItem) this.protocolViolation = 'Codex attempted a tool operation; the study request was stopped.';
        if (!this.busy && (this.protocolViolation || event.error || event.method === 'error'
          || event.params?.item?.type === 'webSearch')) this.stop();
      } catch {
        this.protocolViolation = 'Codex returned invalid JSON.';
        if (!this.busy) this.stop();
      }
    });
  }

  nextId(): number { return ++this.sequence; }

  send(id: number | undefined, method: string, params?: unknown): void {
    if (this.closed || this.invalidated) throw new Error('Codex 临时会话连接已关闭，请明确新建会话后重试。');
    this.child.stdin.write(JSON.stringify({ ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) + '\n');
  }

  stop(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.onClose();
    if (this.closed) return;
    this.child.kill('SIGTERM');
    if (!this.closed) {
      this.timer ??= setTimeout(() => { if (!this.closed) this.child.kill('SIGKILL'); }, 1000);
      this.timer.unref();
    }
  }

  private finish(): void {
    this.closed = true;
    this.invalidated = true;
    if (this.timer) clearTimeout(this.timer);
    this.lines.close();
    this.onClose();
  }
}
