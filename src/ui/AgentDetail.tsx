/**
 * What ZERO knows about one child agent.
 *
 * Compact by design: the brain stays the thing you are looking at, and this is
 * a caption for whichever cluster you focused. Every field is something the
 * operator actually reported — there is no derived or estimated value here, so
 * an agent that ZERO cannot see shows as OFFLINE with the reason rather than as
 * a plausible-looking card.
 */
import type { OperatorAgent, OperatorMission } from '../hwd/types';
import { DEPARTMENT_COLORS, type Department } from '../zero/agentPolicy';

export interface AgentDetailProps {
  agent: OperatorAgent | null;
  missions: OperatorMission[];
  onClose: () => void;
}

function shortPath(path: string): string {
  if (!path) return '—';
  const parts = path.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

export function AgentDetail({ agent, missions, onClose }: AgentDetailProps): React.JSX.Element | null {
  if (!agent) return null;
  const color = DEPARTMENT_COLORS[agent.department as Department];

  const lastMission = missions.find((mission) => mission.agents.includes(agent.id));
  const lastStep = lastMission?.steps.find((step) => step.agent_id === agent.id);

  return (
    <section className="detail-panel" style={{ borderColor: color }}>
      <header className="detail-head">
        <h2>{agent.display_name}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>

      <p className="detail-type" style={{ color }}>
        {agent.department} · child of {agent.parent}
      </p>

      <dl className="detail-rows">
        <div className="detail-row">
          <dt>health</dt>
          <dd className={agent.health === 'HEALTHY' ? '' : 'dim'}>{agent.health}</dd>
        </div>
        <div className="detail-row">
          <dt>status</dt>
          <dd>{agent.status}</dd>
        </div>
        <div className="detail-row">
          <dt>repository</dt>
          <dd title={agent.repo_path}>{shortPath(agent.repo_path)}</dd>
        </div>
        <div className="detail-row">
          <dt>version</dt>
          <dd>{agent.version || '—'}</dd>
        </div>
        <div className="detail-row">
          <dt>invoked as</dt>
          <dd>
            {agent.execution_adapter}
            {agent.entry_point ? ` → ${agent.entry_point}` : ''}
          </dd>
        </div>
        <div className="detail-row">
          <dt>network</dt>
          <dd>{agent.allowed_network_scope}</dd>
        </div>
        {agent.current_mission && (
          <div className="detail-row">
            <dt>mission</dt>
            <dd>{agent.current_mission}</dd>
          </div>
        )}
        {agent.last_activity && (
          <div className="detail-row">
            <dt>last seen</dt>
            <dd>{agent.last_activity.slice(11, 19)}</dd>
          </div>
        )}
      </dl>

      <h3 className="detail-subhead">capabilities</h3>
      <ul className="capability-list">
        {agent.capabilities.map((capability) => (
          <li
            key={capability}
            className={agent.requires_approval_for.includes(capability) ? 'capability-gated' : ''}
            title={
              agent.requires_approval_for.includes(capability)
                ? 'always requires your approval'
                : 'subject to the current autonomy policy'
            }
          >
            {capability}
            {agent.requires_approval_for.includes(capability) ? ' ⟡' : ''}
          </li>
        ))}
      </ul>

      {lastStep && (
        <>
          <h3 className="detail-subhead">last result</h3>
          <p className="detail-description">
            {lastStep.action} — {lastStep.state}
            {lastStep.error ? `: ${lastStep.error}` : ''}
          </p>
        </>
      )}

      {/* Stated explicitly: filesystem scope is the agent's own repository. */}
      <p className="detail-scope">
        scope: {agent.allowed_paths.length > 0 ? shortPath(agent.allowed_paths[0] ?? '') : 'none'}
      </p>
    </section>
  );
}
