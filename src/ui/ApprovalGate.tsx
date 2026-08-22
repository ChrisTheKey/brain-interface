/**
 * The approval gate.
 *
 * This is the one element in the whole interface that is allowed to demand
 * attention, because it is the one moment where nothing continues without a
 * human. It shows exactly what HWD-ZERO is stopped on — the gate, the mission,
 * the objective and the operator's own rationale — and nothing else.
 *
 * There is deliberately no deny button: an unapproved gate stays closed and
 * the mission stays stopped. Denial is the default, not an action.
 */
import type { OperatorApproval } from '../hwd/types';

export interface ApprovalGateProps {
  approvals: OperatorApproval[];
  safeMode: boolean;
  onApprove: (approval: OperatorApproval) => void;
  /** More than this many open gates is a queue, not a decision. */
  maxVisible?: number;
}

function shortMissionId(missionId: string): string {
  const tail = missionId.split('-').at(-1) ?? missionId;
  return tail.length > 10 ? tail.slice(0, 10) : tail;
}

export function ApprovalGate({
  approvals,
  safeMode,
  onApprove,
  maxVisible = 2,
}: ApprovalGateProps): React.JSX.Element | null {
  if (approvals.length === 0) return null;
  const shown = approvals.slice(0, maxVisible);
  const hidden = approvals.length - shown.length;

  return (
    <section className="approvals" aria-label="Approval gates">
      {shown.map((approval) => (
        <article className="approval" key={`${approval.mission_id}:${approval.gate}`}>
          <h3>
            {approval.gate.replace(/_/g, ' ')}
            <span className="approval-mission">{shortMissionId(approval.mission_id)}</span>
          </h3>
          <div className="approval-body">
            <p className="approval-objective">{approval.objective}</p>
            {approval.executor ? (
              <p className="approval-executor dim">blocked agent: {approval.executor}</p>
            ) : null}
            {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
            {approval.rationale ? <p className="approval-rationale">{approval.rationale}</p> : null}
          </div>
          <div className="approval-actions">
            <button type="button" onClick={() => onApprove(approval)} disabled={safeMode}>
              Approve once
            </button>
            <span className="approval-note">
              One mission, one gate. Not a permission — it expires and cannot be reused.
            </span>
          </div>
        </article>
      ))}
      {hidden > 0 ? (
        <p className="dim">
          {hidden} more gate{hidden === 1 ? '' : 's'} waiting.
        </p>
      ) : null}
      {safeMode ? <p className="warn">SAFE MODE is on — approvals are refused.</p> : null}
    </section>
  );
}
