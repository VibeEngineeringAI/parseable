import { type ReactNode, useId } from 'react';
import { cx } from './utils';

export interface FieldOptions {
  label?: string;
  hint?: string;
  error?: string;
}

export function useField(
  id: string | undefined,
  describedBy: string | undefined,
  { hint, error }: FieldOptions,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  return {
    inputId,
    messageId,
    describedBy: cx(describedBy, (hint || error) && messageId) || undefined,
  };
}

export function Field({
  children,
  label,
  hint,
  error,
  inputId,
  messageId,
}: FieldOptions & {
  children: ReactNode;
  inputId: string;
  messageId: string;
}) {
  return (
    <div className="ui-field" data-invalid={Boolean(error) || undefined}>
      {label && (
        <label className="ui-field-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      {children}
      {(hint || error) && (
        <p id={messageId} className="ui-field-message" role={error ? 'alert' : undefined}>
          {error || hint}
        </p>
      )}
    </div>
  );
}
