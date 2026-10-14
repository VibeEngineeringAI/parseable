import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { lineageEdges } from '../../lib/keystone/graph';
import type { InvestigationGraph, NodeGeometry } from '../../lib/keystone/types';
import { renderedHeight, type CardGeometry } from './cardGeometry';
import {
  DRAG_HANDLE,
  InvestigationNodeCard,
  type InvestigationFlowNode,
  type InvestigationNodeData,
} from './InvestigationNodeCard';

export type KeystoneFlowInstance = ReactFlowInstance<InvestigationFlowNode, Edge>;

export interface KeystoneCanvasProps {
  graph: InvestigationGraph;
  /** Stored geometry; collapsed cards keep their expanded height here. */
  geometry: Record<string, CardGeometry>;
  selectedId: string | null;
  /** False when the caller lacks layout permission: no drag, no resize. */
  editable: boolean;
  onSelect: (id: string) => void;
  /**
   * Fired once per finished move or resize (pointer or keyboard). Presentation only:
   * the caller saves geometry under its own layout revision and never starts a run.
   */
  onGeometryChange: (changes: Record<string, CardGeometry>) => void;
  /** Collapses or expands a card. Presentation only; the viewport is left alone. */
  onToggleCollapsed?: (id: string) => void;
  onInit?: (instance: KeystoneFlowInstance) => void;
}

const nodeTypes: NodeTypes = { investigation: InvestigationNodeCard };
const LARGE_GRAPH = 40;

function toFlowNode(
  data: InvestigationNodeData,
  geometry: CardGeometry,
  selected: boolean,
): InvestigationFlowNode {
  return {
    id: data.node.id,
    type: 'investigation',
    position: { x: geometry.x, y: geometry.y },
    width: geometry.width,
    height: renderedHeight(geometry),
    data,
    selected,
    draggable: data.editable,
    deletable: false,
    connectable: false,
    dragHandle: `.${DRAG_HANDLE}`,
    ariaLabel: `${data.node.title}. Press Enter to select${data.editable ? ', arrow keys to move' : ''}.`,
  };
}

function CanvasInner({
  graph,
  geometry,
  selectedId,
  editable,
  onSelect,
  onGeometryChange,
  onToggleCollapsed,
  onInit,
}: KeystoneCanvasProps) {
  const changeRef = useRef(onGeometryChange);
  changeRef.current = onGeometryChange;
  const toggleRef = useRef(onToggleCollapsed);
  toggleRef.current = onToggleCollapsed;
  const onToggle = useCallback<InvestigationNodeData['onToggleCollapsed']>(
    (id) => toggleRef.current?.(id),
    [],
  );
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const onResizeEnd = useCallback<InvestigationNodeData['onResizeEnd']>((id, size) => {
    const stored = geometryRef.current[id];
    changeRef.current({
      [id]: {
        ...stored,
        x: Math.round(size.x),
        y: Math.round(size.y),
        width: Math.round(size.width),
        height: Math.round(size.height),
        pinned: stored?.pinned ?? false,
      },
    });
  }, []);
  const dataFor = useCallback(
    (node: InvestigationGraph['nodes'][number], collapsed: boolean): InvestigationNodeData => ({
      node,
      editable,
      collapsed,
      onResizeEnd,
      onToggleCollapsed: onToggle,
    }),
    [editable, onResizeEnd, onToggle],
  );

  // Seeded synchronously so the first render, and the initial fit, already has nodes.
  const [nodes, setNodes] = useState<InvestigationFlowNode[]>(() =>
    graph.nodes.map((node) =>
      toFlowNode(
        dataFor(node, !!geometry[node.id]?.collapsed),
        geometry[node.id],
        node.id === selectedId,
      ),
    ),
  );
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // A collapsed card is drawn at header height; its stored expanded size is kept.
  const geometryOf = useCallback((id: string): CardGeometry | undefined => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return undefined;
    const stored = geometryRef.current[id];
    return {
      ...stored,
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? 0,
      height: stored?.collapsed ? stored.height : (node.height ?? 0),
      pinned: stored?.pinned ?? false,
    };
  }, []);

  // Reconcile props into flow nodes, keeping object identity for unchanged nodes so a
  // streamed update re-renders only its own card. The viewport is never touched here.
  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const prior = byId.get(node.id);
        const target = geometry[node.id];
        const collapsed = !!target.collapsed;
        const selected = node.id === selectedId;
        if (
          prior &&
          prior.data.node === node &&
          prior.data.editable === editable &&
          prior.data.collapsed === collapsed &&
          prior.selected === selected &&
          (prior.dragging ||
            (prior.position.x === target.x &&
              prior.position.y === target.y &&
              prior.width === target.width &&
              prior.height === renderedHeight(target)))
        )
          return prior;
        const next = toFlowNode(dataFor(node, collapsed), target, selected);
        // A card mid-drag keeps its live position until the drag finishes.
        return prior?.dragging ? { ...next, position: prior.position, dragging: true } : next;
      });
    });
  }, [graph.nodes, geometry, selectedId, editable, dataFor]);

  const onNodesChange = useCallback(
    (changes: NodeChange<InvestigationFlowNode>[]) => {
      // Structural changes are not accepted from the canvas: no add, remove or replace.
      const allowed = changes.filter(
        (change) =>
          change.type === 'position' || change.type === 'dimensions' || change.type === 'select',
      );
      setNodes((current) => applyNodeChanges(allowed, current));
      const finished: Record<string, CardGeometry> = {};
      for (const change of allowed) {
        if (change.type === 'select' && change.selected) selectRef.current(change.id);
        if (change.type === 'position' && change.position && !change.dragging) {
          const before = geometryOf(change.id);
          if (before)
            finished[change.id] = {
              ...before,
              x: Math.round(change.position.x),
              y: Math.round(change.position.y),
            };
        }
      }
      if (Object.keys(finished).length) changeRef.current(finished);
    },
    [geometryOf],
  );

  // The first view only. Large graphs open on the selected card at reading zoom rather
  // than a whole-graph fit that would be unreadably small. Later updates never refit.
  const [initialFit] = useState(() =>
    graph.nodes.length > LARGE_GRAPH && selectedId
      ? { padding: 2, minZoom: 0.85, maxZoom: 0.85, nodes: [{ id: selectedId }] }
      : { padding: 0.12, maxZoom: 1 },
  );

  const edges = useMemo<Edge[]>(
    () =>
      lineageEdges(graph.nodes).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        className: `ks-edge ks-edge-${edge.intent}`,
        selectable: false,
        deletable: false,
        focusable: false,
        reconnectable: false,
        ariaLabel: `${edge.intent === 'explore' ? 'Explores another angle from' : 'Follows up on'} ${edge.source}`,
      })),
    [graph.nodes],
  );

  return (
    <ReactFlow<InvestigationFlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onInit={(instance) => {
        // Explicit initial fit: the fitView prop would run before fitViewOptions reach
        // a store created by our own provider, and would then fit the whole graph.
        void instance.fitView(initialFit);
        onInit?.(instance);
      }}
      nodesDraggable={editable}
      nodesConnectable={false}
      edgesReconnectable={false}
      edgesFocusable={false}
      elementsSelectable
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      selectionOnDrag={false}
      connectOnClick={false}
      zoomOnDoubleClick={false}
      nodeDragThreshold={2}
      onlyRenderVisibleElements={false}
      minZoom={0.05}
      maxZoom={1.75}
      aria-label={`Investigation canvas, ${graph.nodes.length} questions`}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap pannable zoomable position="bottom-right" ariaLabel="Investigation overview" />
    </ReactFlow>
  );
}

export function KeystoneCanvas(props: KeystoneCanvasProps) {
  return (
    <div className="ks-canvas" data-testid="ks-canvas" data-editable={props.editable}>
      <ReactFlowProvider>
        <CanvasInner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
