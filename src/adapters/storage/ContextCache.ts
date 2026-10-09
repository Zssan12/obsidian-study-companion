import { createHash } from 'node:crypto';
import type { FilePort } from '../../core/contracts';
import type { ContextCache } from '../../core/context';

/** Content-addressed derived data. Never stores or reconstructs answer records. */
export class FileContextCache implements ContextCache {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly files: FilePort, private readonly folder: string) {}
  private path(key: string): string { return `${this.folder}/${createHash('sha256').update(key).digest('hex')}.json`; }
  async get(key: string): Promise<string | undefined> {
    const path = this.path(key);
    return await this.files.exists(path) ? this.files.read(path) : undefined;
  }
  async set(key: string, value: string): Promise<void> {
    const work = this.queue.then(async () => {
      if (!await this.files.exists(this.folder)) await this.files.mkdir(this.folder);
      const path = this.path(key);
      if (await this.files.exists(path)) await this.files.process(path, () => value);
      else await this.files.create(path, value);
    });
    this.queue = work.catch(() => {}); await work;
  }
}
