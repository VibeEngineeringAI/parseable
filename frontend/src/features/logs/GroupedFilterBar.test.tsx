import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LogFilterExpression } from '../../lib/logQuery';
import { GroupedFilterBar } from './GroupedFilterBar';

function render(expression: LogFilterExpression, fields = ['service']) {
  return renderToStaticMarkup(
    <GroupedFilterBar
      search="error"
      onSearch={() => {}}
      fields={fields}
      expression={expression}
      onChange={() => {}}
      onClear={() => {}}
    />,
  );
}

function button(markup: string, selector: string) {
  const match = markup.match(new RegExp(`<button[^>]*${selector}[^>]*>`))?.[0];
  expect(match).toBeDefined();
  return match!;
}

describe('GroupedFilterBar', () => {
  it('preserves the search and add-filter selectors for an empty expression', () => {
    const markup = render({ combinator: 'and', groups: [] });
    expect(markup).toContain('aria-label="Search messages"');
    expect(markup).toContain('value="error"');
    expect(button(markup, 'data-testid="add-filter-button"')).not.toContain('disabled');
    expect(markup).toContain('Add group');
  });

  it('shows independent root and group combinators and preserves filter pills', () => {
    const markup = render({
      combinator: 'or',
      groups: [
        {
          id: 'group-1',
          combinator: 'and',
          rules: [{ id: 'rule-1', field: 'service', operator: '!=', value: '<api>' }],
        },
      ],
    });
    expect(markup).toContain('<option value="or" selected="">Any group (OR)</option>');
    expect(markup).toContain('<option value="and" selected="">All filters (AND)</option>');
    expect(markup).toContain('data-filter-group-id="group-1"');
    expect(markup).toContain('data-filter-pill-id="rule-1"');
    expect(markup).toContain('data-testid="filter-pill-value">&lt;api&gt;');
    expect(markup).toContain('aria-label="Edit filter service"');
    expect(markup).toContain('aria-label="Remove group 1"');
  });

  it('disables adding groups at twelve while allowing filters in existing groups', () => {
    const markup = render({
      combinator: 'and',
      groups: Array.from({ length: 12 }, (_, index) => ({
        id: `group-${index}`,
        combinator: 'and',
        rules: [],
      })),
    });
    expect(button(markup, 'data-testid="add-filter-group-button"')).toContain('disabled');
    expect(button(markup, 'data-testid="add-filter-button"')).not.toContain('disabled');
    expect(markup).toContain('Group limit reached (12)');
    expect(markup).toContain('Empty groups are ignored.');
  });

  it('counts the fifty-filter limit across groups and leaves editing available', () => {
    const markup = render({
      combinator: 'and',
      groups: [0, 1].map((group) => ({
        id: `group-${group}`,
        combinator: 'or',
        rules: Array.from({ length: 25 }, (_, index) => ({
          id: `rule-${group}-${index}`,
          field: 'service',
          operator: '=',
          value: 'api',
        })),
      })),
    });
    expect(button(markup, 'data-testid="add-filter-button"')).toContain('disabled');
    expect(button(markup, 'aria-label="Add filter to group 1"')).toContain('disabled');
    expect(button(markup, 'aria-label="Add filter to group 2"')).toContain('disabled');
    expect(button(markup, 'aria-label="Edit filter service"')).not.toContain('disabled');
    expect(markup).toContain('Filter limit reached (50)');
  });

  it('explains why filters cannot be added when fields are unavailable', () => {
    const markup = render({ combinator: 'and', groups: [] }, []);
    expect(button(markup, 'data-testid="add-filter-button"')).toContain('disabled');
    expect(markup).toContain('Fields are not available yet.');
  });
});
