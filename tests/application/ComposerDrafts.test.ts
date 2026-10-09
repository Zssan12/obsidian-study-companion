import { expect, it, vi } from 'vitest';
import { ComposerDrafts, type DraftState } from '../../src/application/ComposerDrafts';
const source = { sourcePath: 'A.md', sourceName: 'A', selectedText: 'chosen', before: '', after: '', from: {line:0,ch:0}, to:{line:0,ch:6} };
it('restores independent source drafts and explicit evidence after reload', async () => {
  let persisted: DraftState | undefined;
  const drafts = new ComposerDrafts(undefined, async state => { persisted = state; });
  drafts.put('study:A.md', { text: 'A question', attachments: [source] });
  drafts.put('study:B.md', { text: 'B question', attachments: [] });
  drafts.put('normal', { text: 'Normal question', attachments: [] });
  drafts.setMode('normal');
  await drafts.flush();
  const restored = new ComposerDrafts(persisted);
  expect(restored.get('study:A.md')).toEqual({ text: 'A question', attachments: [source] });
  expect(restored.get('study:B.md').text).toBe('B question');
  expect(restored.get('normal').text).toBe('Normal question');
  expect(restored.getMode()).toBe('normal');
  const copy = restored.get('study:A.md'); copy.attachments[0]!.selectedText = 'mutated';
  expect(restored.get('study:A.md').attachments[0]!.selectedText).toBe('chosen');
});
it('clears only the submitted draft and never a newer edit', () => {
  const drafts = new ComposerDrafts(); const sent = { text: 'Question', attachments: [source] };
  drafts.put('study:A.md', sent);
  drafts.put('study:B.md', {text:'Other', attachments:[]});
  expect(drafts.clearIfUnchanged('study:A.md', sent)).toBe(true);
  expect(drafts.get('study:B.md').text).toBe('Other');
  drafts.put('study:A.md', {...sent,text:'New question'});
  expect(drafts.clearIfUnchanged('study:A.md', sent)).toBe(false);
  expect(drafts.get('study:A.md').text).toBe('New question');
});
it('serializes persistence, reports errors, and can save a later edit', async () => {
  const failed = vi.fn(); const save = vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(undefined);
  const drafts = new ComposerDrafts(undefined, save, failed);
  drafts.put('normal',{text:'Keep me',attachments:[]});
  await expect(drafts.flush()).rejects.toThrow('Disk full');
  expect(failed).toHaveBeenCalledOnce(); expect(drafts.get('normal').text).toBe('Keep me');
  drafts.put('normal',{text:'Updated',attachments:[]}); await drafts.flush();
  expect(save).toHaveBeenLastCalledWith({version:1,mode:'study',entries:{normal:{text:'Updated',attachments:[]}}});
});
it('rejects invalid stored evidence rather than silently replacing it', () => {
  expect(() => new ComposerDrafts({version:2,entries:{}})).toThrow('原始数据未覆盖');
  expect(() => new ComposerDrafts({version:1,entries:{normal:{text:'A',attachments:[{...source,from:null}]}}})).toThrow('原始数据未覆盖');
});
it('moves source drafts on rename without resurrecting the old key from a live view', async () => {
  let persisted: DraftState | undefined;
  const drafts = new ComposerDrafts(undefined, async state => { persisted = state; });
  drafts.put('study:A.md',{text:'Question',attachments:[source]});
  drafts.renameSource('A.md','B.md');
  const current = drafts.get('study:A.md');
  expect(current.attachments[0]!.sourcePath).toBe('B.md');
  drafts.put('study:A.md',{...current,text:'Still typing'});
  await drafts.flush();
  expect(Object.keys(persisted!.entries)).toEqual(['study:B.md']);
  expect(drafts.get('study:B.md').text).toBe('Still typing');
  drafts.renameSource('B.md','A.md'); await drafts.flush();
  expect(Object.keys(persisted!.entries)).toEqual(['study:A.md']);
});

it('keeps a dismissed quote disabled after send and reload without persisting its text', async () => {
  let persisted: DraftState | undefined;
  const drafts = new ComposerDrafts(undefined, async state => { persisted = state; });
  const sent = { text: 'Question', attachments: [], omitContext: true };
  drafts.put('normal', sent);
  expect(drafts.clearIfUnchanged('normal', sent)).toBe(true);
  await drafts.flush();
  expect(new ComposerDrafts(persisted).get('normal')).toEqual({ text: '', attachments: [], omitContext: true });
});

it('keeps the answer policy after sending and reloading an otherwise empty draft', async () => {
  let persisted: DraftState | undefined;
  const drafts = new ComposerDrafts(undefined, async state => { persisted = state; });
  const sent = { text: 'Question', attachments: [], answerPolicy: 'direct' as const };
  drafts.put('study:A.md', sent);
  expect(drafts.clearIfUnchanged('study:A.md', sent)).toBe(true);
  await drafts.flush();
  expect(new ComposerDrafts(persisted).get('study:A.md')).toEqual({
    text: '',
    attachments: [],
    answerPolicy: 'direct',
  });
});

it('rejects an unknown persisted answer policy without replacing the saved draft', () => {
  expect(() => new ComposerDrafts({
    version: 1,
    entries: {
      'study:A.md': { text: '', attachments: [], answerPolicy: 'sometimes' },
    },
  })).toThrow('回答依据无效，原始数据未覆盖');
});

it('renames Quick Ask source evidence without moving its stable conversation key', async () => {
  const {quickDraftKey}=await import('../../src/application/ComposerDrafts');
  let persisted: DraftState | undefined;
  const drafts=new ComposerDrafts(undefined,async state=>{persisted=state});
  const key=quickDraftKey('unit','quick:one');
  drafts.put(key,{text:'question',attachments:[source],context:source});
  drafts.renameSource('A.md','Renamed.md');await drafts.flush();
  const restored=new ComposerDrafts(persisted);
  expect(restored.get(key).context?.sourcePath).toBe('Renamed.md');
  expect(restored.get(key).attachments[0]?.sourcePath).toBe('Renamed.md');
  expect(()=>new ComposerDrafts({version:1,entries:{'quick:invalid':{text:'bad',attachments:[]}}})).toThrow();
});
