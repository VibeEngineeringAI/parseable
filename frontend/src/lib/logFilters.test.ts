import { expect, it } from 'vitest';
import {
  addGroupRule,
  emptyExpression,
  narrowLogExpression,
  MAX_FILTER_RULES,
  type LogFilterExpression,
} from './logFilters';
const rule = { id: 'rule', field: 'service', operator: '=' as const, value: 'api' };
it('adds to the selected OR group without changing its semantics and ignores duplicates', () => {
  const expression: LogFilterExpression = {
    combinator: 'or',
    groups: [{ id: 'a', combinator: 'or', rules: [rule] }],
  };
  expect(addGroupRule(expression, { ...rule, id: 'copy' }, 'a')).toBe(expression);
  const next = addGroupRule(expression, { ...rule, id: 'b', value: 'worker' }, 'a');
  expect(next.combinator).toBe('or');
  expect(next.groups[0].combinator).toBe('or');
  expect(next.groups[0].rules).toHaveLength(2);
  expect(expression.groups[0].rules).toHaveLength(1);
});
it('narrows an OR group with a new AND condition but refuses to widen multiple OR groups', () => {
  const expression: LogFilterExpression = {
    combinator: 'or',
    groups: [{ id: 'a', combinator: 'or', rules: [rule, { ...rule, id: 'b', value: 'worker' }] }],
  };
  const narrowed = narrowLogExpression(expression, rule, 'new');
  expect(narrowed.combinator).toBe('and');
  expect(narrowed.groups).toHaveLength(2);
  expect(() => narrowLogExpression({ ...narrowed, combinator: 'or' }, rule, 'third')).toThrow(
    'To narrow these OR groups',
  );
  expect(narrowLogExpression(narrowed, { ...rule, id: 'copy' }, 'third')).toBe(narrowed);
});
it('enforces shared capacity while permitting a duplicate no-op at capacity', () => {
  const expression: LogFilterExpression = {
    combinator: 'and',
    groups: [
      {
        id: 'a',
        combinator: 'and',
        rules: Array.from({ length: MAX_FILTER_RULES }, (_, i) => ({
          ...rule,
          id: String(i),
          value: String(i),
        })),
      },
    ],
  };
  expect(addGroupRule(expression, { ...rule, value: '0' }, 'a')).toBe(expression);
  expect(() => addGroupRule(expression, rule, 'a')).toThrow('50 filters');
  expect(() => narrowLogExpression(expression, rule, 'b')).toThrow('Filter limit');
  expect(emptyExpression()).not.toBe(emptyExpression());
});
