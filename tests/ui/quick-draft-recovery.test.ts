// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { QuickAskPopover } from '../../src/ui/quick-ask-popover';
import { ComposerDrafts, type DraftState } from '../../src/application/ComposerDrafts';
import type { SourceContext, StudyApp, StudySnapshot, StudyUnit } from '../../src/core/contracts';
import { prepareSelectionFollowupText } from '../../src/application/selection-followup';
vi.mock('obsidian', () => {
  class Component { addChild<T>(child:T):T{return child} removeChild<T>(child:T):T{return child} register(){} load(){} unload(){} }
  class Modal { contentEl=document.createElement('div'); modalEl=document.createElement('div'); }
  return {Component,Modal,setIcon:vi.fn(),MarkdownRenderer:{render:vi.fn()}};
});
const context: SourceContext = {sourcePath:'A.md',sourceName:'A',selectedText:'original quote',before:'',after:'',from:{line:0,ch:0},to:{line:0,ch:14}};
function setup() {
  let persisted: DraftState | undefined;
  const drafts = new ComposerDrafts(undefined, async state => { persisted=state; });
  const unit: StudyUnit = {id:'A',sourcePath:'A.md',createdAt:'now',quickConversation:{id:'quick:one',provider:'claude'}};
  const snapshot: StudySnapshot = {units:[unit],records:[],running:[],errors:[],pinned:false};
  let finish!:()=>void;
  const submit=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}));
  const study={snapshot:()=>snapshot,subscribe:()=>()=>{},submit,cancel:vi.fn()} as unknown as StudyApp;
  const open=(store=drafts,source=context,owner=unit)=>{
    const view=new QuickAskPopover({} as App,study,owner,source,undefined,undefined,undefined,undefined,
      {importFile:async()=>({...context,sourcePath:'B.md',sourceName:'B'})},owner.quickConversation!.id,'claude',true,store);
    view.onOpen();return view;
  };
  const type=(view:QuickAskPopover,text:string)=>{const input=view.contentEl.querySelector('textarea')!;input.value=text;input.dispatchEvent(new Event('input'));};
  return {drafts,open,type,submit,snapshot,unit,finish:()=>finish(),persisted:()=>persisted};
}

it('prefills a quoted followup without sending and restores it after reopening', async () => {
  const f=setup(); const view=f.open();
  const quote={...context, answerRecordId:'answer', selectedText:'这段回答\n第二行'};
  view.prepareFollowup(quote);
  expect(view.contentEl.querySelector('textarea')!.value).toBe(prepareSelectionFollowupText('',quote.selectedText));
  expect(f.submit).not.toHaveBeenCalled();
  view.prepareFollowup(quote);
  expect(view.contentEl.querySelector('textarea')!.value).toBe(prepareSelectionFollowupText('',quote.selectedText));
  view.onClose(); await f.drafts.flush();
  const reopened=f.open(new ComposerDrafts(f.persisted()));
  expect(reopened.contentEl.querySelector('textarea')!.value).toContain('> 这段回答\n> 第二行');
  expect(f.submit).not.toHaveBeenCalled(); reopened.onClose();
});

it('keeps the existing Quick Ask draft and original context when adding an answer followup', () => {
  const f=setup(); const view=f.open(); f.type(view,'my unsent question');
  const quote={...context,answerRecordId:'answer',selectedText:'new answer quote'};
  view.prepareFollowup(quote);
  expect(view.contentEl.querySelector('textarea')!.value).toBe(prepareSelectionFollowupText('my unsent question',quote.selectedText));
  expect(view.contentEl.textContent).toContain('original quote');
  expect(view.contentEl.querySelectorAll('.study-companion-attachment')).toHaveLength(1);
  view.prepareFollowup(quote);
  expect(view.contentEl.querySelectorAll('.study-companion-attachment')).toHaveLength(1);
  expect(f.submit).not.toHaveBeenCalled(); view.onClose();
});
it('restores custom question, original quote and attachments after close and persisted reload, isolated from other sessions',async()=>{
  const f=setup();const view=f.open();f.type(view,'my unsent question');
  { const input = view.contentEl.querySelector('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: [new File(['fixture'], 'lesson.pdf')] }); input.dispatchEvent(new Event('change')); }
  await vi.waitFor(()=>expect(view.contentEl.querySelectorAll('.study-companion-attachment')).toHaveLength(1));
  view.onClose();await f.drafts.flush();
  const store=new ComposerDrafts(f.persisted());
  const reopened=f.open(store,{...context,selectedText:'different quote'});
  expect(reopened.contentEl.querySelector('textarea')!.value).toBe('my unsent question');
  expect(reopened.contentEl.textContent).toContain('original quote');
  expect(reopened.contentEl.querySelectorAll('.study-companion-attachment')).toHaveLength(1);
  expect(f.submit).not.toHaveBeenCalled();
  const other=f.open(store,context,{...f.unit,quickConversation:{id:'quick:two',provider:'claude'}});
  expect(other.contentEl.querySelector('textarea')!.value).not.toBe('my unsent question');
  reopened.onClose();other.onClose();
});
it('clears an unchanged completed draft even after reopening, but keeps a newer edit',async()=>{
  const f=setup();const view=f.open();f.type(view,'question');
  view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  view.onClose();const reopened=f.open();
  f.finish();await vi.waitFor(()=>expect(reopened.contentEl.querySelector('textarea')!.value).toBe(''));
  f.type(reopened,'next question');reopened.contentEl.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledTimes(2));
  f.type(reopened,'newer edit');f.finish();
  await vi.waitFor(()=>expect(reopened.contentEl.querySelector<HTMLButtonElement>('.study-companion-send')!.hidden).toBe(false));
  expect(reopened.contentEl.querySelector('textarea')!.value).toBe('newer edit');reopened.onClose();
});
it('keeps failed or cancelled questions for reopening',async()=>{
  const f=setup();const view=f.open();f.type(view,'retry later');
  view.contentEl.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
  await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce());
  expect(view.contentEl.querySelector('textarea')!.value).toBe('');
  f.snapshot.errors.push({unitId:'A',kind:'quick',conversationId:'quick:one',requestId:'r',message:'cancelled'});
  view.onClose();f.finish();await Promise.resolve();
  const reopened=f.open();expect(reopened.contentEl.querySelector('textarea')!.value).toBe('retry later');reopened.onClose();
});
