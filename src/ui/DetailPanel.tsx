/**
 * Detail view for a selected node. Only shows values ZERO actually reported —
 * there are no derived KPIs, no invented metrics.
 */
import { useState } from 'react';
import type { GraphEdge, GraphModel, GraphNode } from '../graph/model';
import type { ActivityEvent } from '../zero/adapter';
import type { ZeroAgent } from '../zero/agentRegistry';

export interface DetailPanelProps {
  node: GraphNode | null;
  graph: GraphModel;
  activity: ActivityEvent[];
  /** Set when the selected node is a registry agent ZERO can actually run. */
  agent?: ZeroAgent | null;
  agentBusy?: boolean;
  onRunAgent?: (agent: ZeroAgent, task: string) => void;
  onClose: () => void;
  onSelect: (nodeId: string) => void;
  onSpeak?: (text: string) => void;
}

export function DetailPanel({
  node,
  graph,
  activity,
  agent,
  agentBusy,
  onRunAgent,
  onClose,
  onSelect,
  onSpeak,
}: DetailPanelProps): React.JSX.Element | null {
  const [task, setTask] = useState('');
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
            {node.type} ·{' '}
            {/*
              A node may carry a state of its own that is more truthful than the
              graph status. The ZERO node does: `notLoaded` describes a missing
              snapshot, and reading it as a statement about the runtime is what
              made this line say "zero · notLoaded" while HWD-ZERO was healthy.
            */}
            <span className={`status-${node.status}`}>
              {typeof node.metadata['state'] === 'string' ? node.metadata['state'] : node.status}
            </span>
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

      {agent && onRunAgent ? (
        <section>
          <h3>Run this agent</h3>
          <form
            className="agent-run"
            onSubmit={(event) => {
              event.preventDefault();
              const text = task.trim();
              if (text.length === 0) return;
              setTask('');
              onRunAgent(agent, text);
            }}
          >
            <input
              type="text"
              value={task}
              placeholder={`Task for ${agent.name}`}
              onChange={(event) => setTask(event.target.value)}
              aria-label={`Task for ${agent.name}`}
              disabled={agentBusy}
            />
            <button type="submit" className="text-button" disabled={agentBusy}>
              {agentBusy ? 'ZERO is busy…' : 'run'}
            </button>
          </form>
          <p className="detail-description">
            ZERO starts a thread in <code>{agent.cwd}</code> and runs the task there.
          </p>
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
