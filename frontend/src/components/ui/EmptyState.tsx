import { type ReactNode } from 'react';
import { Search } from 'lucide-react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      <div className="ui-empty-state-icon" aria-hidden="true">
        {icon ?? <Search size={24} strokeWidth={1.5} />}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="ui-empty-state-action">{action}</div>}
    </div>
  );
}
