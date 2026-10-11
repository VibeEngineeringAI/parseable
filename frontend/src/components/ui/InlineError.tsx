// Announces a failed action next to the control that caused it. Renders nothing without a message.
export function InlineError({ error }: { error?: string }) {
  return error ? (
    <p className="error-text" role="alert">
      {error}
    </p>
  ) : null;
}
