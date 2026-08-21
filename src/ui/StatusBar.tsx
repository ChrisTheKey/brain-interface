/**
 * The bottom rail: what ZERO is, right now.
 *
 * Every value here comes from the operator's own status route. The bar used to
 * report the interface's connection to a Codex app-server, which was a true
 * statement about the wrong thing — it said "ZERO disconnected" while HWD-ZERO
 * was running and answering. What is on screen must be the operator's state,
 * because that is the state the operator's decisions act on.
 */
import type { OperatorView } from '../state/useOperator';

export interface StatusBarProps {
  operator: OperatorView;
  voiceState: string;
  onToggleVoice: () => void;
}

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'connecting to ZERO',
  open: 'ZERO online',
  closed: 'reconnecting',
  unreachable: 'ZERO unreachable',
};

export function StatusBar({
  operator,
  voiceState,
  onToggleVoice,
}: StatusBarProps): React.JSX.Element {
  const { status, agents, excluded, connection } = operator;
  const healthy = agents.filter((agent) => agent.health === 'HEALTHY').length;

  return (
    <footer className="status-bar">
      <span className={`connection connection-${connection}`}>
        {CONNECTION_LABEL[connection] ?? connection}
      </span>

      <span className={`conversation-state state-${operator.zeroState.toLowerCase()}`}>
        {operator.zeroState}
      </span>

      <span className="status-agents">
        {healthy}/{agents.length} agents ready
      </span>

      {/* The refusal is shown, not hidden: an excluded repository that exists on
          disk is a decision the operator made, and it should be visible that
          ZERO is honouring it. */}
      {excluded.length > 0 && (
        <span className="status-excluded" title={excluded.join(', ')}>
          {excluded.length} excluded
        </span>
      )}

      {operator.approvals.length > 0 && (
        <span className="status-gate">{operator.approvals.length} awaiting you</span>
      )}

      {status && (
        <span className="dim">
          {status.missions.active} active · {status.missions.total} missions
        </span>
      )}

      <button type="button" className="icon-button" onClick={onToggleVoice}>
        {voiceState === 'speaking' ? 'stop speaking' : 'voice'}
      </button>

      <button type="button" className="icon-button" onClick={() => void operator.refresh()}>
        refresh
      </button>

      {operator.safeMode && <span className="status-safe">SAFE MODE</span>}
    </footer>
  );
}
