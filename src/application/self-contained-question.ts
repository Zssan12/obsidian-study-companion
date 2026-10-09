/** Recognize closed numeric tasks locally; never execute the expression or infer missing operands. */
export function isSelfContainedCalculation(question: string): boolean {
  return calculationExpression(question) !== undefined;
}

export function calculationExpression(question: string): string | undefined {
  if (question.length > 300) return undefined;
  const text = question.normalize('NFKC').trim()
    .replace(/[×]/gu, '*').replace(/[÷]/gu, '/').replace(/[−]/gu, '-');
  const match = /^(?:(?:请(?:帮我)?(?:计算|算一下|算算)?|帮我算一下|计算|算一下|只回复(?:数字|结果|答案)|(?:please )?(?:calculate|compute|what is)|reply with only the result)\s*)?[:：]?\s*([\d.\s()+*/%^=-]+?)\s*(?:等于(?:几|多少)|是多少|对吗|is what)?\s*(?:[,，;；]\s*(?:请)?(?:只回复|只给出)(?:数字|结果|答案))?[?？!！。.]?$/iu.exec(text);
  if (!match) return undefined;
  const expression = match[1]!.trim();
  // Dates and lone page/section numbers are not calculation requests.
  return /\d/u.test(expression) && /[+*/%^=-]/u.test(expression)
    && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/u.test(expression) ? expression : undefined;
}
