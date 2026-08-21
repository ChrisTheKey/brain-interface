import { useState } from 'react';
import type { MissionStep, OperatorApproval, OperatorMission } from '../hwd/types';
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
const MAX_VISIBLE_MISSIONS = 4;

function shortMissionId(missionId: string): string {
  const tail = missionId.split('-').at(-1) ?? missionId;
  return tail.length > 10 ? tail.slice(0, 10) : tail;
}

function missionClass(state: string): string {
  if (state === 'EXECUTING' || state === 'PLANNING') return 'mission-running';
  if (state === 'COMPLETED') return 'mission-done';
  if (state === 'AWAITING_APPROVAL') return 'mission-gate';
  return 'mission-stopped';
}

function stepGlyph(step: MissionStep): string {
  switch (step.state) {
    case 'DONE':
      return '+';
    case 'FAILED':
      return '!';
    case 'SKIPPED':
      return '~';
    case 'AWAITING_APPROVAL':
      return '#';
    case 'RUNNING':
      return '>';
    default:
      return '.';
  }
}

function MissionLine({ mission }: { mission: OperatorMission }): React.JSX.Element {
  return (
    <li className={missionClass(mission.state)}>
      <span className="mission-id">{shortMissionId(mission.id)}</span>
      <span className="mission-task">{mission.objective}</span>
      <span className="mission-status">{mission.state}</span>
      {mission.steps.length > 0 && (
        <span className="mission-steps">
          {mission.steps.map((step) => (
            <abbr
              key={step.id}
              className={`step step-${step.state.toLowerCase()}`}
              title={`${step.agent_id}.${step.action} — ${step.state}${
                step.error ? `: ${step.error}` : ''
              }`}
            >
              {stepGlyph(step)}
            </abbr>
          ))}
        </span>
      )}
    </li>
  );
}

/**
 * One permission gate.
 *
 * Everything the operator needs to decide is on this card — which agent, which
 * capability, what exactly it would do, to what target, at what risk, and the
 * payload itself. A gate that said only "approve?" would be a rubber stamp.
 *
 * The third button is deliberately separated: APPROVE ONCE is about this
 * action, CREATE POLICY changes what ZERO may do unattended from now on. They
 * are different decisions and must not sit side by side as equals.
 */
function ApprovalGate({
  approval,
  onApprove,
  onDeny,
  onCreatePolicy,
  busy,
}: {
  approval: OperatorApproval;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onCreatePolicy: (capability: string) => void;
  busy: boolean;
}): React.JSX.Element {
  const [showPayload, setShowPayload] = useState(false);
  const [confirmPolicy, setConfirmPolicy] = useState(false);

  return (
    <li className="approval" data-risk={approval.risk_level}>
      <header className="approval-head">
        <span className="approval-capability">{approval.capability}</span>
        <span className="approval-risk">{approval.risk_level} risk</span>
      </header>

      <dl className="approval-facts">
        <div>
          <dt>agent</dt>
          <dd>{approval.agent_id}</dd>
        </div>
        <div>
          <dt>action</dt>
          <dd>{approval.action}</dd>
        </div>
        {approval.target && (
          <div>
            <dt>target</dt>
            <dd>{approval.target}</dd>
          </div>
        )}
        {approval.estimated_cost && (
          <div>
            <dt>cost</dt>
            <dd>{approval.estimated_cost}</dd>
          </div>
        )}
        <div>
          <dt>expires</dt>
          <dd>{approval.expires_at.slice(11, 19)}</dd>
        </div>
      </dl>

      <p className="approval-reason">{approval.summary}</p>
      <p className="approval-mission">{shortMissionId(approval.mission_id)}</p>

      <button
        type="button"
        className="approval-payload-toggle"
        onClick={() => setShowPayload((shown) => !shown)}
      >
        {showPayload ? 'hide payload' : 'show payload'}
      </button>
      {showPayload && (
        <pre className="approval-payload">{JSON.stringify(approval.preview, null, 2)}</pre>
      )}

      <div className="approval-actions">
        <button type="button" disabled={busy} onClick={() => onApprove(approval.id)}>
          APPROVE ONCE
        </button>
        <button type="button" disabled={busy} onClick={() => onDeny(approval.id)}>
          DENY
        </button>
      </div>

      {/* Two taps, always. A standing permission is not something to grant by
          brushing a phone screen. */}
      <div className="approval-policy">
        {confirmPolicy ? (
          <>
            <span className="approval-note">
              make {approval.capability} autonomous from now on?
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onCreatePolicy(approval.capability);
                setConfirmPolicy(false);
              }}
            >
              CONFIRM POLICY
            </button>
            <button type="button" onClick={() => setConfirmPolicy(false)}>
              cancel
            </button>
          </>
        ) : (
          <button type="button" className="dim" onClick={() => setConfirmPolicy(true)}>
            CREATE POLICY…
          </button>
        )}
      </div>
    </li>
  );
}

export function OperatorPanel({ operator }: { operator: OperatorView }): React.JSX.Element {
  const visibleApprovals = operator.approvals.slice(0, MAX_VISIBLE_APPROVALS);
  const hiddenApprovals = operator.approvals.length - visibleApprovals.length;
  const activeMissions = operator.missions.slice(0, MAX_VISIBLE_MISSIONS);

  return (
    <aside className={`operator${operator.safeMode ? ' operator-safe' : ''}`}>
      <header className="operator-head">
        <span className="operator-name">ZERO</span>
        <span className={`conversation-state state-${operator.zeroState.toLowerCase()}`}>
          {operator.zeroState}
        </span>
        <span className={`connection connection-${operator.connection}`}>
          {operator.connection}
        </span>
      </header>

      {operator.error && <p className="operator-offline">{operator.error}</p>}

      {operator.approvals.length > 0 && (
        <ul className="approvals">
          {visibleApprovals.map((approval) => (
            <ApprovalGate
              key={approval.id}
              approval={approval}
              busy={operator.busy}
              onApprove={(id) => void operator.approve(id)}
              onDeny={(id) => void operator.deny(id)}
              onCreatePolicy={(capability) => void operator.createPolicy(capability)}
            />
          ))}
          {hiddenApprovals > 0 && (
            <li className="approval-note">+{hiddenApprovals} more waiting</li>
          )}
        </ul>
      )}

      {activeMissions.length > 0 && (
        <ul className="missions">
          {activeMissions.map((mission) => (
            <MissionLine key={mission.id} mission={mission} />
          ))}
        </ul>
      )}

      {/* Server-side: this stops the laptop, not just this screen. */}
      <button
        type="button"
        className={`kill-switch${operator.safeMode ? ' kill-switch-on' : ''}`}
        disabled={operator.busy}
        onClick={() => void (operator.safeMode ? operator.resume() : operator.stop())}
      >
        {operator.safeMode ? 'RESUME ZERO' : 'STOP ZERO'}
      </button>
    </aside>
  );
}
