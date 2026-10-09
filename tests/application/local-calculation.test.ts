import { expect, it } from 'vitest';
import { localCalculation } from '../../src/application/local-calculation';

it.each([
  ['2+2', '4'], ['0.1+0.2', '0.3'], ['(12.5-2)/3', '3.5'], ['1/3', '1/3'],
  ['-2 * (3+4)', '-14'], ['10/4', '2.5'], ['1/-2', '-0.5'], ['2×3+4÷2', '8'],
  ['9007199254740993+1', '9007199254740994'], ['1-1', '0'], ['计算 0.005 + .005', '0.01'],
])('computes exact arithmetic without floating-point rounding: %s', (question, result) => {
  expect(localCalculation(question)).toBe(result);
});

it.each(['1/0', '2**3', '2^3', '20%+3', '2+2=4', '2026-09-21', '2 2+2', '(2+3', '2+3)',
  '2+x', '请查原文2+2为什么等于4', '解释2+2', '2+2; process.exit()', '2+2并联网核实',
  '('.repeat(40) + '2+2' + ')'.repeat(40)])('falls back without running ambiguous or unsupported expressions: %s', question => {
  expect(localCalculation(question)).toBeUndefined();
});
