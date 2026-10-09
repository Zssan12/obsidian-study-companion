// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import type { StudyApp, StudySnapshot } from '../../src/core/contracts';
import { StudyThreadView } from '../../src/ui/study-thread-view';
import { ComposerDrafts } from '../../src/application/ComposerDrafts';
vi.mock('../../src/ui/append-note-modal', () => ({ openAppendNote: vi.fn() }));
vi.mock('obsidian', () => {
  class Component { addChild<T>(child:T):T{return child} removeChild<T>(child:T):T{return child} register(){} registerEvent(){} }
  class ItemView extends Component { contentEl=document.createElement('div'); app={workspace:{on:vi.fn()}} }
  return {Component,ItemView,setIcon:vi.fn(),MarkdownRenderer:{render:vi.fn()}};
});
async function setup() {
  let path = 'A.md';
  let snapshot: StudySnapshot = {mode:'study',units:[{id:'A',sourcePath:'A.md',createdAt:'now'},{id:'B',sourcePath:'B.md',createdAt:'now'}],activeUnitId:'A',pinned:false,records:[],running:[],errors:[]};
  let listener=(_value:StudySnapshot)=>{};
  let finish!:()=>void;
  const submit=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}));
  const study={snapshot:()=>snapshot,subscribe:(cb:typeof listener)=>{listener=cb;return()=>{}},submit} as unknown as StudyApp;
  const drafts=new ComposerDrafts();
  const open=async()=>{
    const view=new StudyThreadView({} as WorkspaceLeaf,study,()=>({sourcePath:path,sourceName:path,selectedText:'chosen text',before:'',after:'',from:{line:0,ch:0},to:{line:0,ch:11}}),async()=>{},undefined,undefined,undefined,{importFile:async()=>null,activeSourcePath:()=>path},drafts);
    await view.onOpen();return view;
  };
  const switchTo=(next:string)=>{path=next+'.md';snapshot={...snapshot,activeUnitId:next};listener(snapshot)};
  const type=(view:StudyThreadView,text:string)=>{const input=view.contentEl.querySelector('textarea')!;input.value=text;input.dispatchEvent(new Event('input'));};
  const fail=()=>{snapshot={...snapshot,errors:[{requestId:'r',unitId:'A',kind:'main',conversationId:'main:A',message:'Network failed'}]};listener(snapshot);finish();};
  return {open,switchTo,type,submit,finish:()=>finish(),fail,drafts};
}
it('restores A/B drafts on file switches and after closing the panel',async()=>{
  const test=await setup();const view=await test.open();
  test.type(view,'A question');test.switchTo('B');
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  test.type(view,'B question');test.switchTo('A');
  expect(view.contentEl.querySelector('textarea')!.value).toBe('A question');
  await view.onClose();const reopened=await test.open();
  expect(reopened.contentEl.querySelector('textarea')!.value).toBe('A question');
  test.switchTo('B');expect(reopened.contentEl.querySelector('textarea')!.value).toBe('B question');
  await reopened.onClose();
});
it('finishing A only clears its unchanged draft while the user writes in B',async()=>{
  const test=await setup();const view=await test.open();test.type(view,'A question');
  view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(test.submit).toHaveBeenCalled());
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  test.switchTo('B');test.type(view,'B question');test.finish();
  await vi.waitFor(()=>expect(test.drafts.get('study:A.md').text).toBe(''));
  expect(view.contentEl.querySelector('textarea')!.value).toBe('B question');
  await view.onClose();
});
it('an answer completing after close updates the reopened composer instead of restoring a stale draft',async()=>{
  const test=await setup();const view=await test.open();test.type(view,'A question');
  view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(test.submit).toHaveBeenCalled());
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  await view.onClose();const reopened=await test.open();
  expect(reopened.contentEl.querySelector('textarea')!.value).toBe('');
  test.finish();
  await vi.waitFor(()=>expect(reopened.contentEl.querySelector('textarea')!.value).toBe(''));
  await reopened.onClose();
});

it('keeps the question available to edit when the backend reports failure',async()=>{
  const test=await setup();const view=await test.open();test.type(view,'A question');
  view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(test.submit).toHaveBeenCalled());
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  test.fail();
  await vi.waitFor(()=>expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(false));
  expect(view.contentEl.querySelector('textarea')!.value).toBe('A question');
  expect(test.drafts.get('study:A.md').text).toBe('A question');
  await view.onClose();
});

it('persists answer policy across reopen and keeps it after a successful send', async () => {
  const test = await setup();
  const view = await test.open();
  test.type(view, 'A question');
  Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>('.study-companion-modes button')).find(button => button.textContent === '直答')!.click();
  await view.onClose();
  const reopened = await test.open();
  expect(reopened.contentEl.querySelector('.study-companion-modes [aria-pressed="true"]')!.textContent).toBe('直答');
  reopened.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(test.submit).toHaveBeenCalled());
  test.finish();
  await vi.waitFor(() => expect(test.drafts.get('study:A.md').text).toBe(''));
  expect(test.drafts.get('study:A.md').answerPolicy).toBe('direct');
  await reopened.onClose();
});

it.each(['success', 'failure'] as const)('preserves new input when the previous send ends in %s', async outcome => {
  const f = await setup(); const view = await f.open(); f.type(view, 'first question');
  view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalled());
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  f.type(view, 'new question');
  if (outcome === 'failure') f.fail(); else f.finish();
  await vi.waitFor(() => expect(view.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(false));
  expect(view.contentEl.querySelector('textarea')!.value).toBe('new question');
  await view.onClose();
});
