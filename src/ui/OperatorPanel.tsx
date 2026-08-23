import type { OperatorApproval, OperatorMission, SocialPlanView } from '../hwd/types';
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

function clock(when: string): string {
  // The runtime sends a wall clock in the brand's timezone, deliberately not an
  // instant — so it is shown as sent, never re-parsed into the viewer's zone.
  // A phone in another country must not redraw the hour the operator chose.
  const [day, time] = when.split('T');
  return time ? `${day} ${time.slice(0, 5)}` : when;
}

/**
 * What is about to be published, per network, before anybody says yes.
 *
 * The whole point of this block is that the operator reads the *actual* text
 * that will appear on each platform — not the draft they typed, which for X or
 * Threads may be a different length. A preview that shows one thing while
 * another goes out is worse than no preview.
 */
function PublishPreview({ plan }: { plan: SocialPlanView }): React.JSX.Element {
  return (
    <div className="publish-preview">
      <dl className="publish-facts">
        <div>
          <dt>Action</dt>
          <dd>{plan.action === 'publish' ? 'Publish' : 'Schedule'}</dd>
        </div>
        <div>
          <dt>Brand</dt>
          <dd>{plan.brand.label}</dd>
        </div>
        <div>
          <dt>Timezone</dt>
          <dd>{plan.timezone}</dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd className="publish-risk">EXTERNAL PUBLISH</dd>
        </div>
      </dl>

      <ul className="publish-targets">
        {plan.targets
          .filter((target) => target.ok)
          .map((target) => (
            <li key={target.network} className="publish-target">
              <span className="publish-network">{target.label}</span>
              <span className="publish-when">
                {clock(target.when)}
                {target.time_source === 'best_time' ? ' · best time' : ''}
              </span>
              <p className="publish-text">{target.text}</p>
              {target.shortened ? (
                <span className="publish-shortened">shortened for {target.label}</span>
              ) : null}
              {target.warnings.map((warning) => (
                <span key={warning} className="publish-warning">
                  {warning}
                </span>
              ))}
            </li>
          ))}
      </ul>

      {plan.draft.media.length > 0 ? (
        <p className="publish-media">
          {plan.draft.media.length} file{plan.draft.media.length === 1 ? '' : 's'}:{' '}
          {plan.draft.media.map((item) => item.url.split('/').at(-1)).join(', ')}
        </p>
      ) : null}

      {plan.blocked.length > 0 ? (
        <ul className="publish-blocked">
          {plan.blocked.map((entry) => (
            <li key={entry.network}>
              <strong>{entry.network}</strong> — {entry.reasons.join('; ')}
            </li>
          ))}
        </ul>
      ) : null}

      {plan.note ? <p className="publish-note">{plan.note}</p> : null}

      {/*
        Shown because it is what the approval is bound to. If the text is
        edited after this, the digest changes and this approval no longer
        applies to anything — the runtime refuses it rather than posting the
        newer version under an older yes.
      */}
      <p className="publish-digest">bound to {plan.digest.slice(0, 12)}</p>
    </div>
  );
}

function ApprovalGate({
  approval,
  onApprove,
  onDeny,
  busy,
}: {
  approval: OperatorApproval;
  onApprove: (approval: OperatorApproval) => void;
  onDeny: (approval: OperatorApproval) => void;
  busy: boolean;
}): React.JSX.Element {
  const publish = approval.gate === 'external_publish';
  const plan = approval.preview;
  return (
    <article className={publish ? 'approval approval-publish' : 'approval'}>
      <h3>
        {approval.gate.replace(/_/g, ' ')}
        <span className="approval-mission">{shortMissionId(approval.mission_id)}</span>
      </h3>
      <p className="approval-objective">{approval.objective}</p>
      {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
      {approval.rationale ? <p className="approval-rationale">{approval.rationale}</p> : null}
      {publish && plan ? <PublishPreview plan={plan} /> : null}
      <div className="approval-actions">
        <button type="button" onClick={() => onApprove(approval)} disabled={busy}>
          Approve once
        </button>
        {/*
          A publish gets an explicit DENY, and a mission gate does not.
          A stopped mission that nobody approves simply stays stopped, so
          denial is already the default there. A prepared post is different:
          the payload is sitting in the runtime waiting, and the operator
          should be able to say *no* and have it dropped rather than leave it
          for whoever clicks next.
        */}
        {publish ? (
          <button type="button" className="approval-deny" onClick={() => onDeny(approval)}>
            Deny
          </button>
        ) : null}
        <span className="approval-note">
          {publish
            ? 'This exact post, once. Editing it afterwards needs a new approval.'
            : 'One mission, one gate. Not a permission — it expires and cannot be reused.'}
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
              onDeny={(item) => void operator.deny(item)}
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
