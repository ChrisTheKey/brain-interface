import type { OperatorApproval, OperatorMission } from '../hwd/types';
import type { OperatorView } from '../state/useOperator';

/**
 * The operator's own surface: what HWD-ZERO is doing, what it is waiting for,
 * and the kill switch.
 *
 * Deliberately not a dashboard. Missions read as a short living list at the
 * edge of the brain, and the only thing that interrupts is an approval gate —
 * which is exactly the moment a human is required.
 */

/** More than a few open gates is a queue, not a decision; the rest is counted. */
const MAX_VISIBLE_APPROVALS = 2;

function shortMissionId(missionId: string): string {
  const tail = missionId.split('-').at(-1) ?? missionId;
  return tail.length > 10 ? tail.slice(0, 10) : tail;
}

function missionClass(status: string): string {
  if (status === 'RUNNING') return 'mission-running';
  if (status === 'DONE') return 'mission-done';
  if (status === 'HUMAN_GATE') return 'mission-gate';
  return 'mission-stopped';
}

function MissionLine({ mission }: { mission: OperatorMission }): React.JSX.Element {
  return (
    <li className={missionClass(mission.status)}>
      <span className="mission-id">{shortMissionId(mission.mission_id)}</span>
      <span className="mission-task">{mission.task_id || mission.objective}</span>
      <span className="mission-status">{mission.status}</span>
    </li>
  );
}

function ApprovalGate({
  approval,
  onApprove,
  busy,
}: {
  approval: OperatorApproval;
  onApprove: (approval: OperatorApproval) => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <article className="approval">
      <h3>
        {approval.gate.replace(/_/g, ' ')}
        <span className="approval-mission">{shortMissionId(approval.mission_id)}</span>
      </h3>
      <p className="approval-objective">{approval.objective}</p>
      {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
      {approval.rationale ? <p className="approval-rationale">{approval.rationale}</p> : null}
      <div className="approval-actions">
        <button type="button" onClick={() => onApprove(approval)} disabled={busy}>
          Approve once
        </button>
        {/*
          There is no "deny" call: an unapproved gate simply stays closed and
          the mission stays stopped. Denial is the default, not an action.
        */}
        <span className="approval-note">
          One mission, one gate. Not a permission — it expires and cannot be reused.
        </span>
      </div>
    </article>
  );
}

export function OperatorPanel({ operator }: { operator: OperatorView }): React.JSX.Element | null {
  const { state, missions, approvals, connection, error, safeMode } = operator;
  const unreachable = connection === 'unreachable' || (!state && connection !== 'connecting');

  // The brain is the interface, so the operator's edge stays small: the gates
  // that need a human, and a short tail of missions. The rest is a count.
  const shown = approvals.slice(0, MAX_VISIBLE_APPROVALS);
  const hidden = approvals.length - shown.length;
  const recent = missions.slice(-5).reverse();

  return (
    <aside className={`operator ${safeMode ? 'operator-safe' : ''}`}>
      <header>
        <span className="operator-name">HWD-ZERO</span>
        {state ? (
          <span className="dim">
            v{state.zero_version} · {state.brain.revision.slice(7, 15)}
          </span>
        ) : (
          <span className="dim">{unreachable ? 'offline' : 'connecting'}</span>
        )}
      </header>

      {unreachable ? (
        <p className="operator-offline">
          {error || 'HWD-ZERO is not answering.'}
          <br />
          <code>zero serve</code> on the laptop brings the operator up.
        </p>
      ) : null}

      {approvals.length > 0 ? (
        <section className="approvals" aria-label="Approval gates">
          {shown.map((approval) => (
            <ApprovalGate
              key={`${approval.mission_id}:${approval.gate}`}
              approval={approval}
              onApprove={(item) => void operator.approve(item)}
              busy={safeMode}
            />
          ))}
          {hidden > 0 ? (
            <p className="dim">
              {hidden} more gate{hidden === 1 ? '' : 's'} waiting.
            </p>
          ) : null}
          {safeMode ? <p className="warn">SAFE MODE is on — approvals are refused.</p> : null}
        </section>
      ) : null}

      {recent.length > 0 ? (
        <ul className="missions" aria-label="Missions">
          {recent.map((mission) => (
            <MissionLine key={mission.mission_id} mission={mission} />
          ))}
        </ul>
      ) : (
        state && <p className="dim">No mission has run yet.</p>
      )}

      {error && !unreachable ? <p className="warn">{error}</p> : null}

      <footer>
        <button
          type="button"
          className={safeMode ? 'kill-switch kill-switch-on' : 'kill-switch'}
          onClick={() => void operator.setSafeMode(!safeMode)}
          disabled={unreachable}
        >
          {safeMode ? 'SAFE MODE — nothing executes' : 'Kill switch'}
        </button>
      </footer>
    </aside>
  );
}
