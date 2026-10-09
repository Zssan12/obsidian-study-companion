import { expect, it, vi } from 'vitest';
import { preparePdfSource, requestedPdfPages } from '../../src/application/pdf-preparation';
import { emptySourceContext } from '../../src/application/composer-context';
it.each([
  ['讲解第7页',[7]],['解释第7至第9页和第12页',[7,8,9,12]],['比较第3、5-7页',[3,5,6,7]],['Explain pages 7-9 and page 12',[7,8,9,12]],
  ['概述第7页',[7]],['总结全文，尤其第7页',undefined],['第7页与其他章节的关系',undefined],['解释这个概念',undefined],
  ['不要第7页，介绍全文',undefined],['第7章的第2个公式',undefined],
] as const)('resolves explicit page scope: %s',(question,pages)=>{expect(requestedPdfPages(question)).toEqual(pages);});
it('reads only requested pages and carries exactly that evidence scope',async()=>{
  const readIndexed=vi.fn(async()=>({preview:'page 7 text',emptyPages:[]}));const close=vi.fn(async()=>{});
  const result=await preparePdfSource(emptySourceContext('a.pdf'),new AbortController().signal,vi.fn(),async()=>({pageCount:200,sha256:'a'.repeat(64),readIndexed,close}),{question:'讲解第7页',wholeDocument:false});
  expect(readIndexed).toHaveBeenCalledWith([7],expect.any(AbortSignal),expect.any(Function));expect(result.pdf?.pages).toEqual([7]);expect(close).toHaveBeenCalledOnce();
});
it('keeps full coverage for outline and rejects out-of-range pages before extraction',async()=>{
  const readIndexed=vi.fn(async()=>({preview:'text',emptyPages:[]}));const close=vi.fn(async()=>{});
  const open=async()=>({pageCount:3,sha256:'a'.repeat(64),readIndexed,close});
  await preparePdfSource(emptySourceContext('a.pdf'),new AbortController().signal,vi.fn(),open,{question:'第2页',wholeDocument:true});
  expect(readIndexed).toHaveBeenCalledWith([1,2,3],expect.any(AbortSignal),expect.any(Function));readIndexed.mockClear();
  await expect(preparePdfSource(emptySourceContext('a.pdf'),new AbortController().signal,vi.fn(),open,{question:'第7页',wholeDocument:false})).rejects.toThrow('共有 3 页');
  expect(readIndexed).not.toHaveBeenCalled();expect(close).toHaveBeenCalledTimes(2);
});
it('does not open when cancelled and closes if cancelled during preparation',async()=>{
  const cancel=new AbortController();cancel.abort();const open=vi.fn();
  await expect(preparePdfSource(emptySourceContext('a.pdf'),cancel.signal,vi.fn(),open)).rejects.toThrow();expect(open).not.toHaveBeenCalled();
  const active=new AbortController();const close=vi.fn(async()=>{});
  await expect(preparePdfSource(emptySourceContext('a.pdf'),active.signal,vi.fn(),async()=>({pageCount:1,sha256:'a'.repeat(64),close,readIndexed:async()=>{active.abort();return {preview:'text',emptyPages:[]};}}))).rejects.toThrow();expect(close).toHaveBeenCalledOnce();
});
