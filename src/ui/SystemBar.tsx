/**
 * One quiet line at the bottom: is this brain looking at a live operator, and
 * what could that operator not provide.
 *
 * Never a dashboard. Everything it says is either a fact from the gateway or a
 * named gap in the backend contract — a missing contract is written out in
 * full so it can be implemented, not hidden behind a generic failure.
 */
import type { GatewayHealth, OperatorConnection, OperatorState } from '../hwd/types';
import type { QualityProfile } from '../three/quality';
import type { VoiceChannelStatus } from '../hwd/voiceChannel';

export interface SystemBarProps {
  connection: OperatorConnection;
  error: string;
  state: OperatorState | null;
  gateway: GatewayHealth | null;
  channelStatus: VoiceChannelStatus;
  quality: QualityProfile | null;
  agents: number;
  notes: string[];
  degradations: string[];
  safeMode: boolean;
  onToggleSafeMode: () => void;
  onRefresh: () => void;
}

export function SystemBar({
  connection,
  error,
  state,
  gateway,
  channelStatus,
  quality,
  agents,
  notes,
  degradations,
  safeMode,
  onToggleSafeMode,
  onRefresh,
}: SystemBarProps): React.JSX.Element {
  const upstreamDown = gateway ? !gateway.upstream.reachable : connection === 'unreachable';

  return (
    <div className="system-bar">
      <span className={`connection connection-${connection}`}>
        HWD-ZERO {upstreamDown ? 'offline' : connection}
      </span>
      {state ? (
        <span className="dim">
          v{state.zero_version} · {agents} agents · {state.missions.running} running
        </span>
      ) : (
        <span className="dim">
          {gateway ? 'gateway up · operator not answering' : 'connecting…'}
        </span>
      )}
      <span className="dim channel">voice ch: {channelStatus}</span>
      {quality ? (
        <span className="dim quality">
          {quality.tier} · dpr {quality.dpr[1].toFixed(2)}
          {quality.bloom ? ' · bloom' : ''}
        </span>
      ) : null}

      <button type="button" className="text-button" onClick={onRefresh}>
        refresh
      </button>
      <button
        type="button"
        className={safeMode ? 'kill-switch kill-switch-on' : 'kill-switch'}
        onClick={onToggleSafeMode}
        disabled={upstreamDown}
        title={
          upstreamDown
            ? 'The kill switch lives in HWD-ZERO — it cannot be set while the operator is unreachable.'
            : 'SAFE MODE refuses every execution until a human turns it off'
        }
      >
        {safeMode ? 'SAFE MODE — nothing executes' : 'Kill switch'}
      </button>

      {error ? <span className="warn">{error}</span> : null}

      {degradations.length > 0 ? (
        <details className="notes notes-degraded">
          <summary className="warn">
            {degradations.length} missing backend contract
            {degradations.length === 1 ? '' : 's'}
          </summary>
          <ul>
            {degradations.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
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
    </div>
  );
}
