import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { NodeAbortController } from '../../src/adapters/claude/electronCompat';

const nodeRequire = createRequire(import.meta.url);
const events = nodeRequire('node:events') as typeof import('node:events');
const originalSetMaxListeners = events.setMaxListeners;

describe('Claude Electron runtime compatibility', () => {
  it('creates signals accepted by Node listener bookkeeping', () => {
    expect(() => events.setMaxListeners(50, new NodeAbortController().signal)).not.toThrow();
  });

  it('preserves Node targets and rejects unrelated invalid targets', () => {
    expect(events.setMaxListeners).toBe(originalSetMaxListeners);
    expect(() => events.setMaxListeners(50, {} as never)).toThrow(/eventTargets/);
  });

  it('delivers cancellation once', () => {
    const controller = new NodeAbortController();
    let count = 0;
    controller.signal.addEventListener('abort', () => { count += 1; });
    controller.abort();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(count).toBe(1);
  });
});
