import { Badge, type BadgeProps } from '../../components/ui';
import type { NodeStatus } from '../../lib/keystone/types';

const LABELS: Record<string, [string, BadgeProps['tone']]> = {
  draft: ['Not run', 'neutral'],
  queued: ['Queued', 'neutral'],
  resolving_scope: ['Resolving scope', 'neutral'],
  awaiting_confirmation: ['Needs scope', 'warning'],
  querying: ['Querying', 'neutral'],
  composing: ['Writing answer', 'neutral'],
  completed: ['Answered', 'success'],
  partial: ['Partial', 'warning'],
  cancelled: ['Cancelled', 'neutral'],
  failed: ['Failed', 'danger'],
  interrupted: ['Interrupted', 'warning'],
};

// An unknown status is shown as itself rather than as any known outcome.
function entry(status: NodeStatus): [string, BadgeProps['tone']] {
  return LABELS[status] ?? [String(status).replace(/_/g, ' '), 'neutral'];
}

export function statusLabel(status: NodeStatus) {
  return entry(status)[0];
}

export function StatusBadge({ status }: { status: NodeStatus }) {
  const [label, tone] = entry(status);
  return (
    <Badge tone={tone} className="ks-status" data-status={status}>
      {label}
    </Badge>
  );
}
