/**
 * META ADS, compactly.
 *
 * Five lines and a button. Meta's own Ads Manager is the dashboard; a second
 * one here would push the brain off its own screen for something checked once
 * a day.
 *
 * What it insists on separating is READ from MANAGE. Meta rolls this out by
 * account, a login can carry `ads_read` without `ads_management`, and a
 * rollout can publish read tools and no write tools — so an interface that
 * showed one CONNECTED line would be implying ZERO could change an account it
 * can only look at.
 */
import { useState } from 'react';
import type { MetaAdsView } from '../state/useMetaAds';

function Row({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <li className={`zero-row zero-row-${tone}`}>
      <span className="zero-row-label">{label}</span>
      <span className="zero-row-value">{value}</span>
    </li>
  );
}

export function MetaAdsPanel({ ads }: { ads: MetaAdsView }): React.JSX.Element {
  const { status } = ads;
  const [opening, setOpening] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const blocked = status?.blocked_by ?? '';
  const connected = status?.connected === true;
  const stale = status?.auth_state?.state === 'reauthentication_required';

  const start = async () => {
    setOpening(true);
    try {
      const url = await ads.connect();
      // Opened rather than navigated to: the operator comes back to a brain
      // that is still running, and the callback tab closes itself.
      window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
      setOpening(false);
    }
  };

  const connectionValue = (() => {
    if (blocked === 'local_only') return 'BLOCKED BY LOCAL-ONLY MODE';
    if (blocked === 'meta_disabled') return 'OFF';
    if (stale) return 'REAUTHENTICATION REQUIRED';
    if (connected) return status?.read_ready ? 'CONNECTED' : 'DEGRADED';
    return ads.loading ? '…' : 'DISCONNECTED';
  })();

  return (
    <section className="meta-ads" aria-label="Meta Ads">
      <ul className="zero-rows">
        <Row
          label="META ADS"
          value={connectionValue}
          tone={blocked || stale ? 'warn' : connected && status?.read_ready ? 'ok' : 'idle'}
        />
        {connected && !blocked ? (
          <>
            <Row
              label="ACCOUNT"
              value={status?.selected_account_label || status?.selected_account || '—'}
              tone={status?.accounts ? 'ok' : 'warn'}
            />
            <Row
              label="READ"
              value={status?.read_ready ? 'READY' : 'NOT READY'}
              tone={status?.read_ready ? 'ok' : 'warn'}
            />
            <Row
              label="MANAGE"
              value={status?.mutation_ready ? 'READY · ASKS FIRST' : 'NOT AUTHORIZED'}
              tone={status?.mutation_ready ? 'ok' : 'warn'}
            />
            <Row label="MCP" value="OFFICIAL META" tone="idle" />
          </>
        ) : null}
      </ul>

      {/*
        Meta's own rollout state, said plainly. There is deliberately no
        workaround offered here and no third-party fallback: an account Meta
        has not enabled is an account ZERO cannot manage.
      */}
      {connected && status?.rollout === 'disabled' ? (
        <p className="warn">META ADS MCP · NOT ENABLED FOR THIS ACCOUNT</p>
      ) : null}
      {ads.manageBlocker ? <p className="dim">{ads.manageBlocker}</p> : null}

      {connected && expanded ? (
        <div className="meta-ads-detail">
          <p className="dim">{status?.endpoint}</p>
          {(status?.account_list ?? []).length > 1 ? (
            <ul className="meta-ads-accounts">
              {(status?.account_list ?? []).map((account) => (
                <li key={account.id}>
                  <button
                    type="button"
                    className={account.id === status?.selected_account ? 'selected' : ''}
                    onClick={() => void ads.selectAccount(account.id)}
                  >
                    {account.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="dim">
            {status?.capabilities.read_tools.length ?? 0} read ·{' '}
            {status?.capabilities.write_tools.length ?? 0} write tools published
          </p>
          {/*
            Shown because it is the one limit an approval cannot lift, and an
            operator should be able to see what is bounding them without
            opening a config file.
          */}
          <p className="dim">
            {status?.budget_guard.configured
              ? `ceiling ${status.budget_guard.max_daily ?? '—'}/day` +
                (status.budget_guard.max_increase_percent
                  ? ` · rise ${status.budget_guard.max_increase_percent}%`
                  : '')
              : 'no spend ceiling set — every change still asks you'}
          </p>
          <button
            type="button"
            className="meta-ads-disconnect"
            onClick={() => void ads.disconnect()}
          >
            Disconnect
          </button>
        </div>
      ) : null}

      {connected ? (
        <button type="button" className="meta-ads-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'less' : 'account and limits'}
        </button>
      ) : null}

      {(!connected || stale) && !blocked ? (
        <button
          type="button"
          className="meta-ads-connect"
          onClick={() => void start()}
          disabled={opening}
        >
          {opening ? 'Opening Meta…' : stale ? 'Reconnect Meta Ads' : 'Connect Meta Ads'}
        </button>
      ) : null}

      {blocked === 'local_only' ? (
        <p className="dim">
          Nothing reaches Meta while ZERO_LOCAL_ONLY is set — reads included.
        </p>
      ) : null}

      {ads.error ? <p className="warn">{ads.error}</p> : null}
    </section>
  );
}
