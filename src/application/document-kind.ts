/** Type belongs to the editable outline, never a filename or isolated keyword. */
export type DocumentKind = 'paper' | 'slides' | 'unknown';
export function documentKind(outline: string): DocumentKind {
  const first = outline.trimStart().split(/\r?\n/u)[0]?.trim();
  return first === '资料类型：论文' ? 'paper' : first === '资料类型：课件' ? 'slides' : 'unknown';
}
export function documentLabels(outline = '') {
  const kind = documentKind(outline);
  return kind === 'paper'
    ? { kind, directory: '阅读目录', section: '阅读章节', noun: '论文', panel: '论文精读' }
    : kind === 'slides'
      ? { kind, directory: '学习目录', section: '学习主题', noun: '课件', panel: '课件讲解' }
      : { kind, directory: '内容目录', section: '内容单元', noun: '资料', panel: '资料讲解' };
}
export const DOCUMENT_KIND_INSTRUCTION = '在同一次梳理中根据原文整体结构识别资料类型，第一行严格写「资料类型：论文」「资料类型：课件」或「资料类型：未确定」。论文需综合研究问题、作者论证、方法或理论、实验或分析、引文等证据；不能仅因出现 Abstract、References、论文标题或文件名就判定为论文。介绍论文的幻灯片仍属课件；综述和理论论文不要求有实验。片段不足或冲突时写未确定，不猜测。论文称阅读目录和阅读章节，课件称学习目录和学习主题，其余称内容目录和内容单元。论文按研究问题与贡献、必要背景、方法或论证、结果与局限组织实际存在的章节，不强套实验模板；仍遵循下方 Markdown 字段和页码约束。';
export const PAPER_READING_POLICY = '这是论文阅读。称论文、阅读章节，不称课件、课程或考试重点。保留循序渐进的概念解释、直观例子、公式符号与关键推导。围绕所选章节解释作者在解决什么问题、为何这样设计、关键假设和适用条件；有实验时核对数据集、基线、指标、消融及比较条件，区分观测结果与因果或统计显著性。理论论文重视命题条件与证明思路，综述重视分类框架和争议，不强行补实验。区分作者声称、文中证据、你的补充解释与批判；创新性不能只凭作者宣称确认。缺失的实验、局限或图表数值明确说未提供，不能编造；不强制每次追问重复整套论文分析。';
