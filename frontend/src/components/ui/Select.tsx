import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { Field, useField, type FieldOptions } from './Field';
import { cx } from './utils';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldOptions {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hint,
    error,
    id,
    className,
    'aria-describedby': describedBy,
    'aria-invalid': invalid,
    ...props
  },
  ref,
) {
  const field = useField(id, describedBy, { hint, error });
  return (
    <Field label={label} hint={hint} error={error} {...field}>
      <div className="ui-select-frame">
        <select
          ref={ref}
          id={field.inputId}
          className={cx('ui-input', 'ui-select', className)}
          aria-describedby={field.describedBy}
          aria-invalid={error ? true : invalid}
          {...props}
        />
        <ChevronDown className="ui-select-chevron" size={14} aria-hidden="true" />
      </div>
    </Field>
  );
});
