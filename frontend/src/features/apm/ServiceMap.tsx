import { useId, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { apmServicePath, type ApmEdge } from '../../lib/apm';
import './apm.css';
export const APM_MAP_NODE_LIMIT = 24;
export const APM_MAP_EDGE_LIMIT = 40;

/** Deterministic breadth layout. Roots begin on the left; cycles are seeded by
 * sorted service name. The diagram and list use the same observed edge data. */
export function layoutApmMap(edges: ApmEdge[]) {
  const ranked = [...edges].sort(
    (a, b) =>
      b.spanCount - a.spanCount ||
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target),
  );
  const names = new Set<string>(),
    included: ApmEdge[] = [];
  for (const edge of ranked) {
    if (included.length >= APM_MAP_EDGE_LIMIT) break;
    const added = Number(!names.has(edge.source)) + Number(!names.has(edge.target));
    if (names.size + added > APM_MAP_NODE_LIMIT) continue;
    names.add(edge.source);
    names.add(edge.target);
    included.push(edge);
  }
  const ordered = [...names].sort(),
    depth = new Map<string, number>();
  const targets = new Set(included.map((edge) => edge.target));
  const roots = ordered.filter((name) => !targets.has(name));
  const queue = [...roots];
  roots.forEach((name) => depth.set(name, 0));
  const visit = () => {
    while (queue.length) {
      const name = queue.shift()!;
      for (const edge of included
        .filter((edge) => edge.source === name)
        .sort((a, b) => a.target.localeCompare(b.target))) {
        if (depth.has(edge.target)) continue;
        depth.set(edge.target, Math.min(3, depth.get(name)! + 1));
        queue.push(edge.target);
      }
    }
  };
  visit();
  for (const name of ordered)
    if (!depth.has(name)) {
      depth.set(name, 0);
      queue.push(name);
      visit();
    }
  const counts = [0, 0, 0, 0];
  const nodes = ordered.map((name) => {
    const column = depth.get(name)!;
    return { name, x: 32 + column * 264, y: 34 + counts[column]++ * 98 };
  });
  return {
    nodes,
    edges: included,
    width: Math.max(528, Math.max(...nodes.map((node) => node.x)) + 220),
    height: Math.max(180, Math.max(...nodes.map((node) => node.y)) + 88),
    limited: included.length < edges.length,
  };
}
export function ServiceMap({
  edges,
  dataset,
  focusedService,
  suffix = '',
}: {
  edges: ApmEdge[];
  dataset: string;
  focusedService?: string;
  suffix?: string;
}) {
  const marker = `apm-arrow-${useId().replaceAll(':', '')}`;
  const graph = useMemo(() => layoutApmMap(edges), [edges]);
  if (!graph.nodes.length) return null;
  const nodes = new Map(graph.nodes.map((node) => [node.name, node]));
  return (
    <div className="apm-map-section">
      <div
        className="apm-map-scroll"
        tabIndex={0}
        role="region"
        aria-label="Directed service map; scroll to explore"
      >
        <svg
          className="apm-service-map"
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          width={graph.width}
          height={graph.height}
          aria-label="Observed service parent to child map"
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const source = nodes.get(edge.source)!,
              target = nodes.get(edge.target)!;
            const forward = target.x > source.x,
              x1 = source.x + 190,
              y1 = source.y + 27,
              x2 = forward ? target.x - 7 : target.x + 190 + 7,
              y2 = target.y + 27;
            const bend = forward ? Math.max(35, (x2 - x1) / 2) : 62;
            return (
              <path
                key={JSON.stringify([edge.source, edge.target])}
                className={`apm-map-edge${focusedService && (edge.source === focusedService || edge.target === focusedService) ? ' apm-map-edge-focused' : ''}`}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${forward ? x2 - bend : x2 + bend} ${y2}, ${x2} ${y2}`}
                fill="none"
                markerEnd={`url(#${marker})`}
              >
                <title>
                  {edge.source} → {edge.target}: {edge.spanCount.toLocaleString()} child spans
                </title>
              </path>
            );
          })}
          {graph.nodes.map((node) => (
            <Link
              key={node.name}
              to={`${apmServicePath(dataset, node.name)}${suffix}`}
              className="apm-map-node"
              aria-label={`Open ${node.name} service insights`}
              aria-current={focusedService === node.name ? 'page' : undefined}
            >
              <title>{node.name}</title>
              <rect x={node.x} y={node.y} width={190} height={54} rx={9} />
              <circle cx={node.x + 18} cy={node.y + 27} r={4} />
              <text x={node.x + 31} y={node.y + 31}>
                {node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}
              </text>
            </Link>
          ))}
        </svg>
      </div>
      <p className="apm-note">
        Arrows follow observed parent → child spans. Select a service for insights. Full names and
        edge metrics appear below.
        {graph.limited &&
          ` Diagram shows up to ${APM_MAP_NODE_LIMIT} services and ${APM_MAP_EDGE_LIMIT} connections ranked by child span count; the list includes all returned connections.`}
      </p>
    </div>
  );
}
