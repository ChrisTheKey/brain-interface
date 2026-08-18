/**
 * A single, quiet status line. Never a dashboard: it only states whether the
 * brain is looking at a live ZERO and what ZERO could not provide.
 */
import type { ConnectionState } from '../zero/client';
import type { GraphModel } from '../graph/model';
import type { ZeroSnapshot } from '../zero/adapter';
import type { VoiceState } from '../voice/service';

export interface StatusBarProps {
  connection: ConnectionState;
  connectionError: string | null;
  zeroUrl: string;
  snapshot: ZeroSnapshot | null;
  graph: GraphModel;
  voiceState: VoiceState;
  voiceReason: string | undefined;
  onActivateVoice: () => void;
  onRefresh: () => void;
}

export function StatusBar({
  connection,
  connectionError,
  zeroUrl,
  snapshot,
  graph,
  voiceState,
  voiceReason,
  onActivateVoice,
  onRefresh,
}: StatusBarProps): React.JSX.Element {
  const counts = graph.nodes.reduce<Record<string, number>>((accumulator, node) => {
    accumulator[node.type] = (accumulator[node.type] ?? 0) + 1;
    return accumulator;
  }, {});

  return (
    <div className="status-bar">
      <span className={`connection connection-${connection}`}>
        ZERO {connection}
        <span className="dim"> · {zeroUrl}</span>
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
