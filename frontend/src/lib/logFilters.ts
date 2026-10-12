import type { LogFilter } from './types';

export const MAX_FILTER_GROUPS = 12;
export const MAX_FILTER_RULES = 50;
export const MAX_LOG_ROWS = 10000;
export type LogFilterGroup = { id: string; combinator: 'and' | 'or'; rules: LogFilter[] };
export type LogFilterExpression = { combinator: 'and' | 'or'; groups: LogFilterGroup[] };
export const emptyExpression = (): LogFilterExpression => ({ combinator: 'and', groups: [] });
export const ruleCount = (expression: LogFilterExpression) =>
  expression.groups.reduce((count, group) => count + group.rules.length, 0);
export const sameRule = (a: Omit<LogFilter, 'id'>, b: Omit<LogFilter, 'id'>) =>
  a.field === b.field && a.operator === b.operator && a.value === b.value;

/** Append inside a chosen group, or create an AND group with the supplied ID. */
export function addGroupRule(
  expression: LogFilterExpression,
  rule: LogFilter,
  groupId: string,
): LogFilterExpression {
  const group = expression.groups.find((item) => item.id === groupId);
  if (group?.rules.some((item) => sameRule(item, rule))) return expression;
  if (ruleCount(expression) >= MAX_FILTER_RULES)
    throw new Error(
      `You can use up to ${MAX_FILTER_RULES} filters. Remove a filter before adding another.`,
    );
  if (!group && expression.groups.length >= MAX_FILTER_GROUPS)
    throw new Error(
      `You can use up to ${MAX_FILTER_GROUPS} groups. Remove a group before adding another.`,
    );
  return {
    ...expression,
    groups: group
      ? expression.groups.map((item) =>
          item === group ? { ...item, rules: [...item.rules, rule] } : item,
        )
      : [...expression.groups, { id: groupId, combinator: 'and', rules: [rule] }],
  };
}

/** Record-sheet filters narrow the whole expression, never widen an OR branch. */
export function narrowLogExpression(
  expression: LogFilterExpression,
  rule: LogFilter,
  newGroupId: string,
): LogFilterExpression {
  if (
    expression.combinator === 'or' &&
    expression.groups.filter((group) => group.rules.length).length > 1
  )
    throw new Error(
      'To narrow these OR groups, add the filter within each group, or change Match groups to All groups (AND).',
    );
  if (
    expression.combinator === 'and' &&
    expression.groups.some(
      (group) =>
        (group.combinator === 'and' || group.rules.length === 1) &&
        group.rules.some((item) => sameRule(item, rule)),
    )
  )
    return expression;
  if (expression.groups.length >= MAX_FILTER_GROUPS || ruleCount(expression) >= MAX_FILTER_RULES)
    throw new Error('Filter limit reached. Remove a group or filter before adding another.');
  return addGroupRule({ ...expression, combinator: 'and' }, rule, newGroupId);
}
