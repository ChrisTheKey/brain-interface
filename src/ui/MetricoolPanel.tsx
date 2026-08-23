/**
 * METRICOOL, compactly.
 *
 * Deliberately not a social media dashboard. Metricool already is one; putting
 * a second one here would push the brain off its own screen for a feature the
 * operator uses once a day. Four lines and a button.
 *
 * The one thing it insists on saying is the difference between *connected* and
 * *able to publish*. They are different facts — an account with no linked
 * networks is connected and can publish nothing — and collapsing them is how an
 * interface ends up implying a post went somewhere it did not.
 */
import { useState } from 'react';
import type { MetricoolView } from '../state/useMetricool';

function Row({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <li className={`zero-row zero-row-${tone}`}>
      <span className="zero-row-label">{label}</span>
      <span className="zero-row-value">{value}</span>
    </li>
  );
}

export function MetricoolPanel({ metricool }: { metricool: MetricoolView }): React.JSX.Element {
  const { status } = metricool;
  const [opening, setOpening] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const blocked = status?.blocked_by ?? '';
  const connected = status?.connected === true;

  const start = async () => {
    setOpening(true);
    try {
      const url = await metricool.connect();
      // Opened rather than navigated to: the operator comes back to a brain
      // that is still running, and the callback tab closes itself.
      window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="metricool" aria-label="Metricool">
      <ul className="zero-rows">
        <Row
          label="METRICOOL"
          value={
            blocked === 'local_only'
              ? 'BLOCKED BY LOCAL-ONLY MODE'
              : blocked === 'metricool_disabled'
                ? 'OFF'
                : connected
                  ? 'CONNECTED'
                  : metricool.loading
                    ? '…'
                    : 'DISCONNECTED'
          }
          tone={blocked ? 'warn' : connected ? 'ok' : 'idle'}
        />
        {connected ? (
          <>
            <Row
              label="BRAND"
              value={status?.brand_list?.[0]?.label ?? `${status?.brands ?? 0}`}
              tone={status?.brands ? 'ok' : 'warn'}
            />
            <Row
              label="NETWORKS"
              value={`${status?.networks.length ?? 0}`}
              tone={status?.networks.length ? 'ok' : 'warn'}
            />
            <Row
              label="PUBLISHING"
              value={status?.publishing_ready ? 'READY · ASKS FIRST' : 'BLOCKED'}
              tone={status?.publishing_ready ? 'ok' : 'warn'}
            />
          </>
        ) : null}
      </ul>

      {connected && expanded ? (
        <div className="metricool-detail">
          <p className="dim">{status?.server}</p>
          <ul className="metricool-networks">
            {(status?.networks ?? []).map((network) => (
              <li key={network}>{network}</li>
            ))}
          </ul>
          {status?.capabilities.missing.length ? (
            <p className="dim">
              not published by this server: {status.capabilities.missing.join(', ')}
            </p>
          ) : null}
          <button type="button" className="metricool-disconnect" onClick={() => void metricool.disconnect()}>
            Disconnect
          </button>
        </div>
      ) : null}

      {connected ? (
        <button type="button" className="metricool-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'less' : 'connected platforms'}
        </button>
      ) : null}

      {!connected && !blocked ? (
        <button type="button" className="metricool-connect" onClick={() => void start()} disabled={opening}>
          {opening ? 'Opening Metricool…' : 'Connect Metricool'}
        </button>
      ) : null}

      {blocked === 'local_only' ? (
        <p className="dim">
          Nothing reaches Metricool while ZERO_LOCAL_ONLY is set. No socket is opened.
        </p>
      ) : null}

      {metricool.error ? <p className="warn">{metricool.error}</p> : null}
    </section>
  );
}
