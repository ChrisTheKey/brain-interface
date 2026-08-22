/**
 * The agent detail view — compact by design.
 *
 * The brain is the interface, so this panel is a card at the edge, not a
 * dashboard: who the agent is, what HWD-ZERO says it can do, what it is doing
 * right now, and which of its capabilities always need a human. Every value
 * comes from the operator's registry or its event stream; nothing is derived
 * and nothing is invented.
 */
import type { BrainCluster, BrainNode } from '../brain/model';
import { departmentRgba } from '../zero/agentPolicy';
import type { Department } from '../zero/agentPolicy';

export interface AgentDetailProps {
  node: BrainNode | null;
  cluster: BrainCluster | null;
  /** Notes about what HWD-ZERO did not provide. */
  notes: string[];
  excluded: string[];
  onClose: () => void;
}

function accentStyle(department: Department | null): React.CSSProperties {
  return department
    ? ({ '--agent-accent': departmentRgba(department, 0.85) } as React.CSSProperties)
    : {};
}

export function AgentDetail({
  node,
  cluster,
  notes,
  excluded,
  onClose,
}: AgentDetailProps): React.JSX.Element | null {
  if (!node) return null;

  if (node.kind === 'core') {
    return (
      <aside className="agent-detail" aria-label="HWD-ZERO">
        <header>
          <h2>HWD-ZERO</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <p className="detail-description">{node.description}</p>
        <dl>
          {Object.entries(node.metadata).map(([key, value]) => (
            <div key={key} className="detail-row">
              <dt>{key}</dt>
              <dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
            </div>
          ))}
        </dl>
        {excluded.length > 0 ? (
          <section>
            <h3>Never registered</h3>
            <p className="dim">{excluded.join(', ')}</p>
          </section>
        ) : null}
        {notes.length > 0 ? (
          <details className="notes">
            <summary>{notes.length} data notes</summary>
            <ul>
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </aside>
    );
  }

  // A satellite belongs to its agent — show the agent, and say which
  // capability was picked.
  const capability = node.kind === 'satellite' ? node.label : '';

  return (
    <aside
      className="agent-detail"
      aria-label={`Agent ${cluster?.label ?? node.label}`}
      style={accentStyle(node.department)}
    >
      <header>
        <div>
          <h2>{cluster?.label ?? node.label}</h2>
          <p className="detail-type">
            {node.department ?? 'no department'} ·{' '}
            <span className={`status-${node.status}`}>{node.status}</span>
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {capability ? (
        <p className="detail-capability">
          <span className="transcript-tag">capability</span>
          {capability}
        </p>
      ) : null}

      {cluster?.purpose ? <p className="detail-description">{cluster.purpose}</p> : null}

      {cluster?.activity ? (
        <p className="detail-activity">
          <span className="transcript-tag">now</span>
          {cluster.activity}
          {cluster.missionId ? <span className="dim"> · {cluster.missionId}</span> : null}
        </p>
      ) : null}

      {cluster && cluster.strengths.length > 0 ? (
        <section>
          <h3>Strengths</h3>
          <ul className="chips">
            {cluster.strengths.map((strength) => (
              <li key={strength}>{strength}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {cluster && cluster.requiresApprovalFor.length > 0 ? (
        <section>
          <h3>Always needs a human</h3>
          <ul className="chips chips-gate">
            {cluster.requiresApprovalFor.map((gate) => (
              <li key={gate}>{gate}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3>Reported by HWD-ZERO</h3>
        <dl>
          {Object.entries(node.metadata).map(([key, value]) => (
            <div key={key} className="detail-row">
              <dt>{key}</dt>
              <dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="detail-footnote dim">
        Every action for this agent runs inside HWD-ZERO. The interface can ask; it never executes.
      </p>
    </aside>
  );
}
