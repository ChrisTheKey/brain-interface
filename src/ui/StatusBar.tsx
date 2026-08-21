/**
 * A single, quiet status line. Never a dashboard: it only states whether the
 * brain is looking at a live ZERO and what ZERO could not provide.
 *
 * What it deliberately no longer prints is an internal address. The old line
 * read `ZERO disconnected · ws://127.0.0.1:8787`, which is wrong twice over:
 * it names a port the browser has no business knowing, and on a phone that
 * address is the phone. It now names the *public* path — `/ws` — which is
 * true from every device.
 */
import type { GraphModel } from '../graph/model';
import type { ZeroSnapshot } from '../zero/adapter';
import type { VoiceState } from '../voice/service';
import type { ZeroStatusView } from '../state/useZeroStatus';

export interface StatusBarProps {
  status: ZeroStatusView;
  connectionError: string | null;
  snapshot: ZeroSnapshot | null;
  graph: GraphModel;
  voiceState: VoiceState;
  voiceReason: string | undefined;
  onActivateVoice: () => void;
  onRefresh: () => void;
  /** Development diagnostics only. */
  showDiagnostics: boolean;
}

export function StatusBar({
  status,
  connectionError,
  snapshot,
  graph,
  voiceState,
  voiceReason,
  onActivateVoice,
  onRefresh,
  showDiagnostics,
}: StatusBarProps): React.JSX.Element {
  const counts = graph.nodes.reduce<Record<string, number>>((accumulator, node) => {
    accumulator[node.type] = (accumulator[node.type] ?? 0) + 1;
    return accumulator;
  }, {});

  const publicWsPath = status.health?.publicPaths.ws ?? '/ws';

  return (
    <div className="status-bar">
      <span className={`connection connection-${status.state.toLowerCase()}`}>
        ZERO {status.headline}
        <span className="dim">
          {' · '}
          {status.ready ? publicWsPath : status.retryable ? 'retrying…' : publicWsPath}
        </span>
      </span>
      {snapshot ? (
        <span className="dim">
          {counts['agent'] ?? 0} agents · {counts['subAgent'] ?? 0} sub-agents ·{' '}
          {counts['skill'] ?? 0} knowledge · {counts['mcpServer'] ?? 0} tool providers ·{' '}
          {counts['tool'] ?? 0} tools
        </span>
      ) : (
        <span className="dim">waiting for ZERO…</span>
      )}
      <button type="button" className="text-button" onClick={onRefresh}>
        refresh
      </button>
      <button type="button" className="text-button" onClick={onActivateVoice}>
        voice: {voiceState}
      </button>
      {connectionError ? <span className="warn">{connectionError}</span> : null}
      {voiceReason && voiceState === 'unavailable' ? (
        <span className="warn">{voiceReason}</span>
      ) : null}
      {/* Internal host:port never leaves the gateway unless diagnostics are on. */}
      {showDiagnostics && status.health?.diagnostics ? (
        <span className="dim">
          dev · {status.health.diagnostics.zeroApi} · {status.health.diagnostics.zeroRuntimeWs}
        </span>
      ) : null}
      {graph.notes.length > 0 ? (
        <details className="notes">
          <summary>{graph.notes.length} data notes</summary>
          <ul>
            {graph.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
