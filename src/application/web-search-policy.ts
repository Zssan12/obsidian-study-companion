export interface PreviousExchange { question: string; answer: string }

const NO_WEB = /(?:不要|不用|无需|不必|不需要|别).{0,8}(?:联网|上网|搜索|查网页)|仅(?:用|根据)|只(?:用|根据|看).{0,12}(?:资料|笔记|选区|原文)|\b(?:do not|don't|no|without)\s+(?:web\s+)?(?:search|brows|internet)/iu;

/** Eligibility, not an instruction to search. Ordinary turns incur no web-planning call. */
export function mayUseWeb(question: string, previous?: PreviousExchange): boolean {
  const text = question.trim();
  if (NO_WEB.test(text)) return false;
  const publicLookup = /(?:^|[，。；!?！？,;]|并|然后|再|也)(?:请|帮我|能否|可以|能不能|麻烦)?\s*(?:联网|上网)(?:查|搜|核实|核对|看看|看一下)/u.test(text)
    || /(?:查找|搜索|查一下|查查|找一下|找|核实|核对|提供|给我).{0,35}(?:官方|网页|网上|外部|文献|论文|研究|来源链接)/u.test(text)
    || /(?:有|有没有).{0,20}(?:官方资料|官方文档|参考文献|论文|外部证据)/u.test(text)
    || /\b(?:search|look\s+up|browse|verify|check|find)\b.{0,60}\b(?:web|online|official|sources?|papers?|research)\b/iu.test(text);
  const urlRequest = /https?:\/\//iu.test(text) && /(?:打开|读取|看看|看一下|总结|说明|概括|内容|\b(?:read|open|summari[sz]e|fetch)\b)/iu.test(text);
  const currentFacts = /(?:最新|近期|最近|今年|目前|现在).{0,35}(?:版本|价格|研究|论文|进展|更新|发布|新闻|支持|现状|变化|还有)/u.test(text)
    || /\b(?:latest|current|recent|today'?s?)\b.{0,40}\b(?:version|price|research|papers?|release|news|status|updates?)\b/iu.test(text);
  if (publicLookup || urlRequest || currentFacts) return true;
  if (!previous) return false;
  // Only the immediately preceding exchange in this same conversation can resolve an assent.
  const assent = /^(?:好(?:的)?[，, ]*)?(?:可以|查一下|查查|你查一下|帮我查一下|继续查|那查一下|就查这个|查证一下|那?(?:现在|最近|今年|目前)呢|yes|go ahead|please do|check it)[。！!？? ]*$/iu.test(text);
  const proposal = /(?:可以|要不要|是否|需要|我能).{0,35}(?:联网|上网|查证|查.{0,8}(?:最新|官方)|搜索)/u.test(previous.answer)
    || /\b(?:can|shall|would you like|could)\b.{0,50}\b(?:search|look up|browse|verify)\b/iu.test(previous.answer);
  return assent && !NO_WEB.test(previous.question) && !NO_WEB.test(previous.answer)
    && (proposal || mayUseWeb(previous.question));
}
