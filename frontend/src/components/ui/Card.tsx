import { forwardRef, type HTMLAttributes } from 'react';
import { cx } from './utils';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cx('ui-card', className)} {...props} />;
});
