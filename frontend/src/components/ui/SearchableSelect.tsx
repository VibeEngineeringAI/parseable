import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fuzzyFilter } from '../../lib/fuzzy';
import { Field, useField, type FieldOptions } from './Field';
import './SearchableSelect.css';

export interface SearchableSelectProps extends FieldOptions {
  id?: string;
  value: string;
  options: ReadonlyArray<{ value: string; label?: string }>;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  onRetry?: () => void;
  placeholder?: string;
  emptyLabel?: string;
  'aria-describedby'?: string;
}

const MAX_OPTIONS = 100;

export function SearchableSelect({
  id,
  label,
  hint,
  error,
  value,
  options,
  onValueChange,
  disabled = false,
  loading = false,
  onRetry,
  placeholder = 'Search datasets…',
  emptyLabel = 'No matching datasets',
  'aria-describedby': describedBy,
}: SearchableSelectProps) {
  const field = useField(id, describedBy, { hint, error });
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | undefined>();
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? selected?.value ?? value;
  const matches = fuzzyFilter(options, query, (option) => option.label ?? option.value);
  const visible = matches.slice(0, MAX_OPTIONS);
  const expanded = open && !disabled;
  const listId = `${field.inputId}-options`;
  const countId = `${field.inputId}-count`;
  const activeIndex = loading ? -1 : visible.findIndex((option) => option.value === active);
  const show = () => {
    if (!disabled) {
      setOpen(true);
      setQuery('');
      setActive(undefined);
    }
  };
  const close = () => {
    setOpen(false);
    setQuery('');
    setActive(undefined);
  };
  const choose = (next: string) => {
    if (next !== value) onValueChange(next);
    close();
    input.current?.focus();
  };

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    // Capture before the dialog's document listener so the first Escape closes only this list.
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', escape, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (active !== undefined && activeIndex < 0) setActive(undefined);
  }, [active, activeIndex]);

  useEffect(() => {
    if (expanded && activeIndex >= 0) {
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex, expanded, listId]);

  return (
    <Field label={label} hint={hint} error={error} {...field}>
      <div
        className="ui-searchable-select"
        ref={root}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
        }}
      >
        <div className="ui-searchable-select-control">
          <div className="ui-select-frame">
            <input
              ref={input}
              id={field.inputId}
              className="ui-input ui-searchable-select-input"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={expanded}
              aria-controls={expanded ? listId : undefined}
              aria-activedescendant={
                expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
              }
              aria-describedby={
                [field.describedBy, expanded ? countId : undefined].filter(Boolean).join(' ') ||
                undefined
              }
              aria-invalid={error ? true : undefined}
              aria-busy={loading || undefined}
              disabled={disabled}
              autoComplete="off"
              placeholder={loading ? 'Loading datasets…' : placeholder}
              value={expanded ? query : selectedLabel}
              onFocus={(event) => event.currentTarget.select()}
              onClick={() => {
                if (!expanded) show();
              }}
              onChange={(event) => {
                setOpen(true);
                setQuery(event.target.value);
                setActive(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (!expanded) {
                    show();
                    if (!loading && options.length) {
                      setActive(
                        options[
                          event.key === 'ArrowDown' ? 0 : Math.min(options.length, MAX_OPTIONS) - 1
                        ].value,
                      );
                    }
                    return;
                  }
                  const nextIndex =
                    event.key === 'ArrowDown'
                      ? Math.min(activeIndex + 1, visible.length - 1)
                      : activeIndex < 0
                        ? visible.length - 1
                        : Math.max(activeIndex - 1, 0);
                  setActive(visible[nextIndex]?.value);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!expanded) show();
                  else if (activeIndex >= 0 && !loading) choose(visible[activeIndex].value);
                } else if (event.key === 'Tab') close();
              }}
            />
            <ChevronDown className="ui-select-chevron" size={14} aria-hidden="true" />
          </div>
          {error && onRetry && (
            <button
              type="button"
              className="ui-searchable-select-retry"
              aria-label="Retry loading datasets"
              disabled={disabled || loading}
              onClick={() => {
                input.current?.focus();
                setOpen(true);
                setActive(undefined);
                onRetry();
              }}
            >
              Retry
            </button>
          )}
        </div>
        {expanded && (
          <div
            className="ui-searchable-select-popup"
            onMouseDown={(event) => event.preventDefault()}
          >
            <div
              id={listId}
              role="listbox"
              aria-label={label ?? 'Datasets'}
              aria-busy={loading || undefined}
              className="ui-searchable-select-options"
            >
              {!loading &&
                visible.map((option, index) => (
                  <div
                    key={option.value}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={option.value === value}
                    data-active={index === activeIndex || undefined}
                    className="ui-searchable-select-option"
                    onPointerMove={(event) => {
                      if (event.pointerType === 'mouse') setActive(option.value);
                    }}
                    onClick={() => choose(option.value)}
                  >
                    {option.label ?? option.value}
                  </div>
                ))}
            </div>
            <p id={countId} role="status" className="ui-searchable-select-status">
              {loading
                ? 'Loading datasets…'
                : !matches.length
                  ? emptyLabel
                  : matches.length > MAX_OPTIONS
                    ? `Showing ${MAX_OPTIONS} of ${matches.length} matches. Refine your search.`
                    : `${matches.length} ${matches.length === 1 ? 'option' : 'options'}`}
            </p>
          </div>
        )}
      </div>
    </Field>
  );
}
