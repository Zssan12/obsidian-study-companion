import { expect, it } from 'vitest';
import { StudyController } from '../../src/application/StudyController';
import { deriveLesson } from '../../src/application/lesson';
import type { BackendRequest, BackendEvent, StudyRecord, StudyState, StudyRepository, SourceContext } from '../../src/core/contracts';
async function fixture() {
 let state:StudyState={version:1,units:[]}; const records:StudyRecord[]=[], requests:BackendRequest[]=[]; let serial=0;
 const repository:StudyRepository={async loadState(){return structuredClone(state);},async saveState(s){state=structuredClone(s);},async listRecords(){return structuredClone(records);},async createRecord(r){records.push(structuredClone(r));},async updateStatus(){}};
 let onRead: (() => void) | undefined; let answer='Synthetic answer';
 const backend={hasSession:()=>true,dispose(){},async *run(r:BackendRequest):AsyncIterable<BackendEvent>{requests.push(r);yield {type:'session',sessionId:r.sessionId??`thread-${requests.length}`};yield {type:'text',text:answer};yield {type:'done'};}};
 const context:SourceContext={sourcePath:'AuditCourse.pdf',sourceName:'AuditCourse',selectedText:'Synthetic two-page course',before:'',after:'',from:{line:0,ch:0},to:{line:0,ch:0},pdf:{indexed:true,sha256:'a'.repeat(64),pageCount:2,pages:[1,2],emptyPages:[]}};
 const services={configuration:()=> 'audit',semanticPlanning:false,library:{async read(_hash:string,pages:readonly number[]){onRead?.();return pages.map(page=>({page,text:`Synthetic evidence page ${page}`}));}}};
 const app=new StudyController(backend,repository,()=>`id-${++serial}`,()=>new Date(1800000000000+serial*1000).toISOString(),()=> 'codex',undefined,services);
 await app.initialize();const unit=await app.startStudy(context);
 records.push({id:'plan',unitId:unit.id,conversationId:`main:${unit.id}`,kind:'main',provider:'codex',context,question:'plan',answer:'## 1. OLD_TOPIC\n页码：1\n目标：OLD_OBJECTIVE\n\n## 2. Topic B\n页码：2\n目标：Second topic',createdAt:new Date(1800000000000).toISOString(),status:'unresolved',state:'complete',lesson:{kind:'plan'}});
 await app.refreshRecords();
 const teach=async(index:number)=>{const lesson=deriveLesson(app.snapshot().units[0]!,app.snapshot().records,context)!;await app.submit({unitId:unit.id,kind:'main',context,question:'Explain selected topic',lesson:{kind:'teach',planId:lesson.plan.id,topicKey:lesson.topics[index]!.key}});};
 return {app,unit,context,records,requests,teach,onRead:(fn:()=>void)=>{onRead=fn;},setAnswer:(text:string)=>{answer=text;}};
}

it.each(['edit', 'remove', 'pages'])('rejects an outdated lesson after %s before submission', async change => {
 const f=await fixture();
 if(change==='remove') f.records.splice(0,1);
 else f.records[0]!.answer=f.records[0]!.answer.replace(change==='pages'?'页码：1':'OLD_OBJECTIVE',change==='pages'?'页码：2':'NEW_OBJECTIVE');
 await expect(f.teach(0)).rejects.toThrow();
 expect(f.requests).toHaveLength(0);await f.app.dispose();
});
it('rejects a lesson changed while PDF evidence is being prepared', async () => {
 const f=await fixture();f.onRead(()=>{f.records[0]!.answer=f.records[0]!.answer.replace('OLD_OBJECTIVE','NEW_OBJECTIVE');});
 await f.teach(0);expect(f.requests).toHaveLength(0);expect(f.records.at(-1)!.state).toBe('error');await f.app.dispose();
});
it('accepts earlier same-thread evidence but still rejects unread pages', async () => {
 const f=await fixture();f.setAnswer('First [p1](AuditCourse.pdf#page=1)');await f.teach(0);
 f.setAnswer('Comparison [p1](AuditCourse.pdf#page=1) and [p2](AuditCourse.pdf#page=2)');await f.teach(1);
 expect(f.requests[1]!.sessionId).toBe('thread-1');expect(f.records.at(-1)!.state).toBe('complete');
 f.setAnswer('Invented [p3](AuditCourse.pdf#page=3)');await f.teach(1);expect(f.records.at(-1)!.state).toBe('error');await f.app.dispose();
});
it('does not inherit evidence merely from Markdown answers when rebuilding', async () => {
 const f=await fixture();f.setAnswer('First [p1](AuditCourse.pdf#page=1)');await f.teach(0);
 f.records[1]!.answer += ' manual edit';
 f.setAnswer('Old reference [p1](AuditCourse.pdf#page=1)');await f.teach(1);
 expect(f.requests[1]!.sessionId).toBeUndefined();expect(f.records.at(-1)!.state).toBe('error');await f.app.dispose();
});
it('preserves evidence through direct followups but clears it on rebuild', async () => {
 const f=await fixture();f.setAnswer('First [p1](AuditCourse.pdf#page=1)');await f.teach(0);
 const direct=()=>f.app.submit({unitId:f.unit.id,kind:'main',context:f.context,question:'Recall the definition',answerPolicy:'direct'});
 await direct();expect(f.records.at(-1)!.state).toBe('complete');expect(f.requests[1]!.sessionId).toBe('thread-1');
 f.records[1]!.answer+=' edited';await direct();
 expect(f.requests[2]!.sessionId).toBeUndefined();expect(f.records.at(-1)!.state).toBe('error');await f.app.dispose();
});
it('does not inherit evidence after a PDF version change', async () => {
 const f=await fixture();f.setAnswer('First [p1](AuditCourse.pdf#page=1)');await f.teach(0);
 const changed={...f.context,sourcePages:[2],selectedText:'New version page 2',pdf:{...f.context.pdf!,indexed:undefined,sha256:'b'.repeat(64),pages:[2]}};
 await f.app.submit({unitId:f.unit.id,kind:'main',context:changed,question:'Explain new version',answerPolicy:'source'});
 expect(f.requests[1]!.sessionId).toBeUndefined();expect(f.records.at(-1)!.state).toBe('error');await f.app.dispose();
});
it('does not share main-thread evidence with Quick Ask', async () => {
 const f=await fixture();f.setAnswer('First [p1](AuditCourse.pdf#page=1)');await f.teach(0);
 const quick=await f.app.startQuick(f.unit.id,'codex');
 const context={...f.context,selectedText:'Only page 2',pdf:{...f.context.pdf!,indexed:undefined,pages:[2]}};
 await f.app.submit({unitId:f.unit.id,kind:'quick',conversationId:quick,context,question:'Explain selection'});
 expect(f.requests[1]!.sessionId).toBeUndefined();expect(f.records.at(-1)!.state).toBe('error');await f.app.dispose();
});
