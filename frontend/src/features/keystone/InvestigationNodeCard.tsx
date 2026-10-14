import { memo } from 'react';
import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react';
import { formatDuration } from '../../lib/keystone/context';
import { MIN_NODE_HEIGHT, MIN_NODE_WIDTH } from '../../lib/keystone/layout';
import { ACTIVE_STATUSES, type GraphNode } from '../../lib/keystone/types';
import { StatusBadge } from './StatusBadge';

export type InvestigationNodeData = {
  node: GraphNode;
  editable: boolean;
  /** Presentation only: a collapsed card shows its header strip. */
  collapsed: boolean;
  /** Commits a resize; presentation only. */
  onResizeEnd: (id: string, size: { width: number; height: number; x: number; y: number }) => void;
  /** Toggles the collapsed state; presentation only, never a semantic change. */
  onToggleCollapsed: (id: string) => void;
};

export type InvestigationFlowNode = Node<InvestigationNodeData, 'investigation'>;

export const DRAG_HANDLE = 'ks-drag-handle';

function InvestigationNodeCardImpl({ id, data, selected }: NodeProps<InvestigationFlowNode>) {
  const { node, editable, collapsed } = data;
  const duration = Date.parse(node.scope.end) - Date.parse(node.scope.start);
  const bodyId = `ks-node-content-${id}`;
  const active = ACTIVE_STATUSES.includes(node.status);
  return (
    <article
      className="ks-card"
      aria-busy={active || undefined}
      data-status={node.status}
      data-intent={node.intent}
      data-selected={selected || undefined}
      data-collapsed={collapsed || undefined}
      data-testid={`ks-node-${id}`}
      aria-label={`${node.title}, ${node.status.replace('_', ' ')}${collapsed ? ', collapsed' : ''}`}
    >
      <NodeResizer
        isVisible={selected && editable && !collapsed}
        minWidth={MIN_NODE_WIDTH}
        minHeight={MIN_NODE_HEIGHT}
        handleClassName="ks-resize-handle"
        lineClassName="ks-resize-line"
        onResizeEnd={(_event, params) => data.onResizeEnd(id, params)}
      />
      <Handle type="target" position={Position.Left} isConnectable={false} className="ks-handle" />
      <header
        className={editable ? `ks-card-header ${DRAG_HANDLE}` : 'ks-card-header'}
        data-testid={`ks-node-header-${id}`}
      >
        {editable ? <GripVertical aria-hidden size={14} className="ks-grip" /> : null}
        {/* nodrag/nokey: pressing the toggle never starts a drag or moves the card. */}
        <button
          type="button"
          className="ks-collapse nodrag nokey"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.title}`}
          title={collapsed ? 'Expand card' : 'Collapse card'}
          data-testid={`ks-node-toggle-${id}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onToggleCollapsed(id);
          }}
        >
          {collapsed ? (
            <ChevronRight aria-hidden size={14} />
          ) : (
            <ChevronDown aria-hidden size={14} />
          )}
        </button>
        <p className="ks-card-title" title={node.title}>
          {node.title}
        </p>
        <StatusBadge status={node.status} />
        {/* Indeterminate: the server reports steps, not a fraction complete. */}
        {active ? (
          <span className="ks-card-progress" aria-hidden data-testid={`ks-node-progress-${id}`} />
        ) : null}
      </header>
      <div className="ks-card-content" id={bodyId} hidden={collapsed}>
        <div className="ks-card-body nodrag nopan nowheel" data-testid={`ks-node-body-${id}`}>
          <p className="ks-card-prompt">{node.prompt}</p>
          {node.answer ? (
            <p className="ks-card-answer">{node.answer}</p>
          ) : (
            <p className="ks-card-answer ks-muted">
              {node.status === 'draft'
                ? 'Not run yet. Run it to get an answer you can follow up on.'
                : active
                  ? 'Run in progress.'
                  : 'No answer yet.'}
            </p>
          )}
        </div>
        <footer className="ks-card-footer">
          <span className="ks-chip" data-tone={node.scopeChanged ? 'warning' : undefined}>
            {node.scopeChanged ? 'Scope changed: ' : ''}
            {formatDuration(duration)}, {node.scope.datasets.length}{' '}
            {node.scope.datasets.length === 1 ? 'dataset' : 'datasets'}
          </span>
          <span className="ks-chip">
            {node.evidenceCount} {node.evidenceCount === 1 ? 'source' : 'sources'}
          </span>
        </footer>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} className="ks-handle" />
    </article>
  );
}

export const InvestigationNodeCard = memo(InvestigationNodeCardImpl);
