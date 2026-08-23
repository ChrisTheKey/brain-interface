import type {
  AdsPlanView,
  OperatorApproval,
  OperatorMission,
  SocialPlanView,
} from '../hwd/types';
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

function money(value: unknown): string {
  return typeof value === 'string' && value ? value : '—';
}

/**
 * What is about to happen to a real ad account, with real money on it.
 *
 * A mutation shows OLD beside NEW, because "CHF 50/day" means nothing to a
 * person until they see the CHF 30 it replaces — and the runtime binds both
 * into the digest, so approving 30→50 is not approval to set 50 on something
 * that has since become 200.
 *
 * A creation shows the whole structure and, at the bottom, whether the thing
 * will deliver. That line is the one that costs money.
 */
function AdsPreview({ plan }: { plan: AdsPlanView }): React.JSX.Element {
  const creating = plan.action === 'create';
  const targeting = plan.ad_set?.targeting;
  const where = targeting
    ? [...targeting.cities, ...targeting.regions, ...targeting.countries].join(', ')
    : '';
  return (
    <div className="ads-preview">
      <dl className="publish-facts">
        <div>
          <dt>Action</dt>
          <dd>{plan.action.toUpperCase()}</dd>
        </div>
        <div>
          <dt>Ad account</dt>
          <dd>{plan.account.label}</dd>
        </div>
        {creating ? (
          <>
            <div>
              <dt>Campaign</dt>
              <dd>{plan.campaign?.name}</dd>
            </div>
            <div>
              <dt>Objective</dt>
              <dd>{plan.campaign?.objective}</dd>
            </div>
            <div>
              <dt>Daily budget</dt>
              <dd className="ads-money">
                {money(plan.ad_set?.daily_budget_display ?? plan.campaign?.daily_budget_display)}
              </dd>
            </div>
            {plan.ad_set?.lifetime_budget_display ? (
              <div>
                <dt>Lifetime budget</dt>
                <dd className="ads-money">{plan.ad_set.lifetime_budget_display}</dd>
              </div>
            ) : null}
            <div>
              <dt>Locations</dt>
              <dd>
                {where || 'not stated'}
                {targeting?.radius_km ? ` +${targeting.radius_km}km` : ''}
              </dd>
            </div>
            <div>
              <dt>Audience</dt>
              <dd>
                {targeting?.age_min || targeting?.age_max
                  ? `${targeting.age_min || 18}–${targeting.age_max || 65}`
                  : 'Meta default'}
                {targeting?.languages.length ? ` · ${targeting.languages.join('/')}` : ''}
              </dd>
            </div>
            <div>
              <dt>Placements</dt>
              <dd>{plan.ad_set?.placements.join(', ') || 'automatic'}</dd>
            </div>
            <div>
              <dt>Optimization</dt>
              <dd>{plan.ad_set?.optimization_goal || 'Meta default'}</dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>
                {plan.ad_set?.start_time || 'immediately when activated'}
                {plan.ad_set?.timezone ? ` · ${plan.ad_set.timezone}` : ''}
              </dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>Object</dt>
              <dd>
                {plan.entity?.label || plan.entity?.id} ({plan.entity?.type})
              </dd>
            </div>
            <div>
              <dt>Old</dt>
              <dd className="ads-old">
                {money(plan.before?.['daily_budget_display']) !== '—'
                  ? money(plan.before?.['daily_budget_display'])
                  : String(plan.before?.['status'] ?? '—')}
              </dd>
            </div>
            <div>
              <dt>New</dt>
              <dd className="ads-money">
                {money(plan.after?.['daily_budget_display']) !== '—'
                  ? money(plan.after?.['daily_budget_display'])
                  : String(plan.after?.['status'] ?? '—')}
              </dd>
            </div>
          </>
        )}
        <div>
          <dt>Risk</dt>
          <dd className="publish-risk">PAID ADVERTISING</dd>
        </div>
      </dl>

      {plan.campaign?.special_ad_categories.length ? (
        <p className="ads-category">
          Special ad categories: {plan.campaign.special_ad_categories.join(', ')}
        </p>
      ) : null}

      {creating && plan.creative ? (
        <div className="ads-creative">
          <span className="publish-network">{plan.creative.headline}</span>
          <p className="publish-text">{plan.creative.primary_text}</p>
          {plan.creative.call_to_action ? (
            <span className="publish-shortened">
              {plan.creative.call_to_action} → {plan.creative.link}
            </span>
          ) : null}
        </div>
      ) : null}

      {/*
        The line that costs money. Creation lands paused where Meta supports
        it, and activating is a separate approval — so this says which of the
        two the operator is about to authorise.
      */}
      {creating ? (
        <p className={plan.activates ? 'ads-delivering' : 'ads-paused'}>
          {plan.activates
            ? 'DELIVERS IMMEDIATELY — this approval includes activation'
            : 'CREATED PAUSED — activating is a separate approval'}
        </p>
      ) : null}

      {plan.warnings.length > 0 ? (
        <ul className="publish-blocked">
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

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
  const advertising = approval.gate === 'paid_advertising';
  // Both kinds bind an approval to an exact payload; what differs is what the
  // payload is and what it costs if it is wrong.
  const irreversible = publish || advertising;
  const plan = approval.preview;
  return (
    <article className={irreversible ? 'approval approval-publish' : 'approval'}>
      <h3>
        {approval.gate.replace(/_/g, ' ')}
        <span className="approval-mission">{shortMissionId(approval.mission_id)}</span>
      </h3>
      <p className="approval-objective">{approval.objective}</p>
      {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
      {approval.rationale ? <p className="approval-rationale">{approval.rationale}</p> : null}
      {publish && plan ? <PublishPreview plan={plan as SocialPlanView} /> : null}
      {advertising && plan ? <AdsPreview plan={plan as AdsPlanView} /> : null}
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
        {irreversible ? (
          <button type="button" className="approval-deny" onClick={() => onDeny(approval)}>
            Deny
          </button>
        ) : null}
        <span className="approval-note">
          {advertising
            ? 'This exact change, once. Spend ceilings apply underneath and no approval lifts them.'
            : publish
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
