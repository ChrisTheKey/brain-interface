/**
 * Detail view for a selected node. Only shows values ZERO actually reported —
 * there are no derived KPIs, no invented metrics.
 */
import type { GraphEdge, GraphModel, GraphNode } from '../graph/model';
import type { ActivityEvent } from '../zero/adapter';

export interface DetailPanelProps {
  node: GraphNode | null;
  graph: GraphModel;
  activity: ActivityEvent[];
  onClose: () => void;
  onSelect: (nodeId: string) => void;
  onSpeak?: (text: string) => void;
}

export function DetailPanel({
  node,
  graph,
  activity,
  onClose,
  onSelect,
  onSpeak,
}: DetailPanelProps): React.JSX.Element | null {
  if (!node) return null;

  const nodesById = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  const outgoing = graph.edges.filter((edge) => edge.source === node.id);
  const incoming = graph.edges.filter((edge) => edge.target === node.id);
  const threadId = typeof node.metadata['threadId'] === 'string' ? node.metadata['threadId'] : null;
  const related = threadId
    ? activity.filter((event) => event.threadId === threadId).slice(0, 12)
    : activity.filter((event) => (event.touches ?? []).includes(node.id)).slice(0, 12);

  const renderRelation = (edge: GraphEdge, direction: 'in' | 'out'): React.JSX.Element => {
    const otherId = direction === 'out' ? edge.target : edge.source;
    const other = nodesById.get(otherId);
    return (
      <li key={`${edge.id}:${direction}`}>
        <span className="relation-kind">{edge.relationship}</span>
        <button type="button" className="relation-link" onClick={() => onSelect(otherId)}>
          {other?.label ?? otherId}
        </button>
      </li>
    );
  };

  return (
    <aside className="detail-panel" aria-label={`Details for ${node.label}`}>
      <header>
        <div>
          <h2>{node.label}</h2>
          <p className="detail-type">
            {node.type} · <span className={`status-${node.status}`}>{node.status}</span>
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      {node.description ? <p className="detail-description">{node.description}</p> : null}

      {Object.keys(node.metadata).length > 0 ? (
        <section>
          <h3>Reported by ZERO</h3>
          <dl>
            {Object.entries(node.metadata).map(([key, value]) => (
              <div key={key} className="detail-row">
                <dt>{key}</dt>
                <dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {outgoing.length > 0 || incoming.length > 0 ? (
        <section>
          <h3>Relationships</h3>
          <ul className="relations">
            {incoming.map((edge) => renderRelation(edge, 'in'))}
            {outgoing.map((edge) => renderRelation(edge, 'out'))}
          </ul>
        </section>
      ) : null}

      {related.length > 0 ? (
        <section>
          <h3>Live activity</h3>
          <ul className="activity-list">
            {related.map((event) => (
              <li key={event.id}>
                <span className="activity-kind">{event.kind}</span>
                <span className="activity-label">{event.label}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {node.type === 'zero' && onSpeak ? (
        <section>
          <button
            type="button"
            className="text-button"
            onClick={() => onSpeak('ZERO online. All systems under control.')}
          >
            Let ZERO speak
          </button>
        </section>
      ) : null}
    </aside>
  );
}
