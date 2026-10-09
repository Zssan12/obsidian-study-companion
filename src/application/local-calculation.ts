import { calculationExpression } from './self-contained-question';

type Rational = { n: bigint; d: bigint };
function fraction(n: bigint, d = 1n): Rational {
  if (!d || n.toString().length > 300 || d.toString().length > 300) throw new Error('Calculation outside local bounds');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n; let b = d;
  while (b) { const next = a % b; a = b; b = next; }
  return { n: n / a, d: d / a };
}

/** Exact decimal arithmetic over a closed grammar. No evaluation of source code or missing operands. */
export function localCalculation(question: string): string | undefined {
  const expression = calculationExpression(question);
  if (!expression || /[%^=]/u.test(expression)) return undefined;
  const tokens = expression.match(/\d+(?:\.\d*)?|\.\d+|[()+*/-]/gu) ?? [];
  if (tokens.join('') !== expression.replace(/\s/gu, '')) return undefined;
  let position = 0;
  const atom = (depth: number): Rational => {
    if (depth > 32) throw new Error('Too deeply nested');
    const token = tokens[position++];
    if (token === '+' || token === '-') {
      const value = atom(depth + 1); return token === '-' ? fraction(-value.n, value.d) : value;
    }
    if (token === '(') {
      const value = sum(depth + 1);
      if (tokens[position++] !== ')') throw new Error('Unclosed group');
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(token) || token.length > 40) throw new Error('Not a number');
    const [whole, decimal = ''] = token.split('.');
    return fraction(BigInt((whole || '0') + decimal), 10n ** BigInt(decimal.length));
  };
  const product = (depth: number): Rational => {
    let left = atom(depth);
    while (tokens[position] === '*' || tokens[position] === '/') {
      const op = tokens[position++]; const right = atom(depth);
      left = op === '*' ? fraction(left.n * right.n, left.d * right.d) : fraction(left.n * right.d, left.d * right.n);
    }
    return left;
  };
  const sum = (depth: number): Rational => {
    let left = product(depth);
    while (tokens[position] === '+' || tokens[position] === '-') {
      const op = tokens[position++]; const right = product(depth);
      left = fraction(left.n * right.d + (op === '+' ? 1n : -1n) * right.n * left.d, left.d * right.d);
    }
    return left;
  };
  try {
    const value = sum(0);
    if (position !== tokens.length) return undefined;
    if (value.d === 1n) return String(value.n);
    let remaining = value.d; let scale = 0;
    while (remaining % 2n === 0n) { remaining /= 2n; scale++; }
    let fives = 0;
    while (remaining % 5n === 0n) { remaining /= 5n; fives++; }
    scale = Math.max(scale, fives);
    if (remaining !== 1n || scale > 40) return String(value.n) + '/' + String(value.d);
    const digits = ((value.n < 0n ? -value.n : value.n) * (10n ** BigInt(scale)) / value.d).toString().padStart(scale + 1, '0');
    return (value.n < 0n ? '-' : '') + digits.slice(0, -scale) + '.' + digits.slice(-scale);
  } catch { return undefined; }
}
