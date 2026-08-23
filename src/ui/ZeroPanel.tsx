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
import type { WakeDiagnostics } from '../voice/wakeSession';
import type { FishAudioStatus } from '../voice/fishAudioProvider';
import { ttsSummary } from '../state/useTtsStatus';

export interface ZeroPanelProps {
  status: ZeroStatusView;
  /**
   * Child agents actually discovered on disk, against the number the policy
   * allows. Deliberately not HWD-ZERO's role registry: those six entries are
   * ZERO's own roles and executors, and showing them here is what put
   * "6 REGISTERED" next to a policy that names eight.
   */
  childAgents: { discovered: number; allowed: number; missing: string[] } | null;
  voiceState: VoiceState;
  onRetry: () => void;
  /** Hands-free, when it is switched on. Null when it is not. */
  wake: WakeDiagnostics | null;
  /** Which voice speaks, and whether it is a cloud one. */
  tts: FishAudioStatus | null;
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
  childAgents,
  voiceState,
  onRetry,
  wake,
  tts,
  showDiagnostics,
}: ZeroPanelProps): React.JSX.Element {
  const health = status.health;

  const zeroTone = health?.zero === 'healthy' ? 'ok' : health ? 'bad' : 'wait';
  const streamTone =
    status.eventStream === 'full' ? 'ok' : status.eventStream === 'partial' ? 'warn' : 'bad';
  const runtimeTone =
    status.runtime === 'online' ? 'ok' : status.runtime === 'unknown' ? 'wait' : 'bad';

  // "N of M" whenever the two differ, so a shortfall is visible rather than
  // rounded away into a number that looks complete.
  const agentValue =
    childAgents === null
      ? 'DISCOVERING'
      : childAgents.discovered === childAgents.allowed
        ? `${childAgents.discovered} REGISTERED`
        : `${childAgents.discovered}/${childAgents.allowed} DISCOVERED`;

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
          value={status.eventStream.toUpperCase()}
          tone={streamTone}
        />
        {/*
          The canonical runtime: HWD-ZERO's ZeroSession. Never an executor —
          this row said OFFLINE while HWD-ZERO was perfectly healthy, because
          it was reporting an optional codex app-server instead.
        */}
        <Row
          label="ZERO RUNTIME"
          value={
            status.runtime === 'online'
              ? 'ONLINE'
              : status.runtime === 'unknown'
                ? 'PROBING'
                : 'OFFLINE'
          }
          tone={runtimeTone}
        />
        <Row
          label="AGENTS"
          value={agentValue}
          tone={
            childAgents === null
              ? 'wait'
              : childAgents.discovered === childAgents.allowed
                ? 'ok'
                : 'warn'
          }
        />
        <Row
          label="VOICE"
          value={voiceState === 'unavailable' ? 'UNAVAILABLE' : voiceState.toUpperCase()}
          tone={voiceState === 'unavailable' ? 'warn' : 'ok'}
        />
      </ul>

      {/*
        An optional executor, shown only when one is configured. A row reading
        OFFLINE for something this deployment never runs is a false alarm, and
        a phone is exactly such a deployment.
      */}
      {status.codexExecutor !== 'not_configured' ? (
        <ul className="zero-rows">
          <Row
            label="CODEX EXECUTOR"
            value={status.codexExecutor === 'online' ? 'ONLINE' : 'OFFLINE'}
            tone={status.codexExecutor === 'online' ? 'ok' : 'warn'}
          />
        </ul>
      ) : null}

      {childAgents && childAgents.missing.length > 0 ? (
        <details className="zero-diagnostics">
          <summary>{childAgents.missing.length} not found</summary>
          <ul>
            {childAgents.missing.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {status.retryable ? (
        <button type="button" className="zero-retry" onClick={onRetry}>
          Retry
        </button>
      ) : null}

      {/*
        Where ZERO's voice comes from, and — the part that matters — whether
        saying it sends text to someone else. Compact by design: a permanent
        dashboard for this would be ignored within a day, and this line has to
        keep being read.
      */}
      <p className={`zero-tts zero-tts-${ttsSummary(tts).mode === 'LOCAL' ? 'local' : 'cloud'}`}>
        <span className="zero-tts-label">VOICE</span>
        <span className="zero-tts-mode">{ttsSummary(tts).mode}</span>
        <span className="zero-tts-voice">{ttsSummary(tts).voice}</span>
        {ttsSummary(tts).note ? (
          <span className="zero-tts-note">{ttsSummary(tts).note}</span>
        ) : null}
      </p>

      {wake ? (
        <details className="zero-diagnostics">
          <summary>hey zero</summary>
          <ul>
            {/* Measured, not assumed: each line is what the running listener
                reports about itself. No audio and no transcript appears here. */}
            <li>wake word · {wake.phrase}</li>
            <li>provider · {wake.provider}</li>
            <li>wake status · {wake.status}</li>
            <li>mic · {wake.microphone}</li>
            <li>vad · {wake.vad}</li>
            <li>stt · {wake.stt}</li>
            <li>
              last wake ·{' '}
              {wake.lastWakeAt ? new Date(wake.lastWakeAt).toLocaleTimeString() : 'never'}
            </li>
            <li>wakes · {wake.wakeCount}</li>
            <li>false activations · {wake.falseActivationCount}</li>
            {wake.batterySaver ? <li>battery saver · on</li> : null}
          </ul>
        </details>
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
