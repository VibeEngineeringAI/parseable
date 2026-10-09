import { forwardRef, type HTMLAttributes } from 'react';
import { cx } from './utils';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = 'neutral', className, ...props },
  ref,
) {
  return <span ref={ref} className={cx('ui-badge', className)} data-tone={tone} {...props} />;
});
