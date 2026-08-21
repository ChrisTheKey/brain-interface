/**
 * The ZERO panel: what ZERO actually is right now.
 *
 * It used to read `zero · notLoaded`, which is a statement about a graph node
 * and says nothing about the backend. This panel states the connection state
 * itself, and every line under it is a fact the gateway or ZERO reported —
 * never a value derived from the fact that React finished rendering.
 */
import type { ZeroStatusView } from '../state/useZeroStatus';
import type { VoiceState } from '../voice/service';

export interface ZeroPanelProps {
  status: ZeroStatusView;
  /** Agents HWD-ZERO's registry reports, or null while it has not answered. */
  registeredAgents: number | null;
  /** Agents ZERO's own runtime snapshot reports. */
  runtimeAgents: number | null;
  voiceState: VoiceState;
  onRetry: () => void;
  /** Development diagnostics only; internal addresses never ship to the LAN. */
  showDiagnostics: boolean;
}

function Row({ label, value, tone }: { label: string; value: string; tone: string }): React.JSX.Element {
  return (
    <li className={`zero-row zero-row-${tone}`}>
      <span className="zero-row-label">{label}</span>
      <span className="zero-row-value">{value}</span>
    </li>
  );
}

export function ZeroPanel({
  status,
  registeredAgents,
  runtimeAgents,
  voiceState,
  onRetry,
  showDiagnostics,
}: ZeroPanelProps): React.JSX.Element {
  const health = status.health;

  const zeroTone = health?.zero === 'healthy' ? 'ok' : health ? 'bad' : 'wait';
  const streamTone = status.ready
    ? 'ok'
    : status.state === 'BACKEND_CONNECTED'
      ? 'ok'
      : status.state === 'DEGRADED'
        ? 'warn'
        : 'bad';

  const agentCount = registeredAgents ?? runtimeAgents;

  return (
    <section className={`zero-panel zero-panel-${status.state.toLowerCase()}`} aria-label="ZERO">
      <header>
        <span className="zero-title">ZERO</span>
        <span className="zero-state">{status.headline}</span>
      </header>

      <p className="zero-detail">{status.detail}</p>

      {status.ready ? <p className="zero-operator">Central Operator · ONLINE</p> : null}

      <ul className="zero-rows">
        <Row
          label="HWD-ZERO"
          value={health ? (health.zero === 'healthy' ? 'HEALTHY' : 'OFFLINE') : 'PROBING'}
          tone={zeroTone}
        />
        <Row
          label="EVENT STREAM"
          value={
            status.state === 'READY' || status.state === 'BACKEND_CONNECTED'
              ? 'CONNECTED'
              : status.state === 'DEGRADED'
                ? 'PARTIAL'
                : 'DISCONNECTED'
          }
          tone={streamTone}
        />
        {/*
          Only shown when a runtime app-server is actually configured. A row
          reading "OFFLINE" for a component this deployment never runs is a
          false alarm, and a phone is exactly such a deployment.
        */}
        {health?.runtimeConfigured ? (
          <Row
            label="ZERO RUNTIME"
            value={health.websocket === 'healthy' ? 'CONNECTED' : 'OFFLINE'}
            tone={health.websocket === 'healthy' ? 'ok' : 'warn'}
          />
        ) : null}
        <Row
          label="AGENTS"
          value={agentCount === null ? 'UNKNOWN' : `${agentCount} REGISTERED`}
          tone={agentCount ? 'ok' : 'wait'}
        />
        <Row
          label="VOICE"
          value={voiceState === 'unavailable' ? 'UNAVAILABLE' : voiceState.toUpperCase()}
          tone={voiceState === 'unavailable' ? 'warn' : 'ok'}
        />
      </ul>

      {status.retryable ? (
        <button type="button" className="zero-retry" onClick={onRetry}>
          Retry
        </button>
      ) : null}

      {showDiagnostics && health?.diagnostics ? (
        <details className="zero-diagnostics">
          <summary>diagnostics</summary>
          <ul>
            <li>api upstream · {health.diagnostics.zeroApi}</li>
            <li>ws upstream · {health.diagnostics.zeroRuntimeWs}</li>
            <li>zero · {health.diagnostics.zeroDetail}</li>
            <li>socket · {health.diagnostics.websocketDetail}</li>
          </ul>
        </details>
      ) : null}
    </section>
  );
}
