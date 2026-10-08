import { forwardRef, type InputHTMLAttributes } from 'react';
import { Field, useField, type FieldOptions } from './Field';
import { cx } from './utils';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldOptions {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
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
      <input
        ref={ref}
        id={field.inputId}
        className={cx('ui-input', className)}
        aria-describedby={field.describedBy}
        aria-invalid={error ? true : invalid}
        {...props}
      />
    </Field>
  );
});
