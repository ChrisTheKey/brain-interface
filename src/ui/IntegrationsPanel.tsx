/**
 * Integrations panel: Meta Ads, Google Ads, Gmail and the ZERO Browser.
 *
 * Every line here is a fact from ZERO — whether the server is in its config,
 * whether it is running, whether it is signed in, how many tools it exposes.
 * "Connect" writes the entry into ZERO's own config through ZERO; "sign in"
 * asks ZERO to run the OAuth flow. The panel never claims a connection the
 * backend has not confirmed, and it never holds a credential.
 */
import { useState } from 'react';
import type { IntegrationState, IntegrationStatus } from '../mcp/provisioning';
import type { IntegrationsApi } from '../state/useIntegrations';
import type { BrowserBridgeApi } from '../state/useBrowserBridge';
import { ZERO_BROWSER } from '../mcp/catalog';

const STATE_LABEL: Record<IntegrationState, string> = {
  notConfigured: 'not registered',
  outdated: 'needs update',
  configured: 'not running',
  needsSignIn: 'sign-in required',
  connected: 'connected',
  disabled: 'disabled',
};

export interface IntegrationsPanelProps {
  integrations: IntegrationsApi;
  /** Live browser facts, so ZERO's internet access is visible, not implied. */
  browser: BrowserBridgeApi;
}

export function IntegrationsPanel({
  integrations,
  browser,
}: IntegrationsPanelProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { statuses, pending, busy, error, notice, authorizationUrl } = integrations;
  const connected = statuses.filter((status) => status.state === 'connected').length;

  return (
    <section className={`integrations-panel ${open ? 'open' : ''}`} aria-label="Integrations">
      <button
        type="button"
        className="integrations-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        integrations {connected}/{statuses.length}
      </button>

      {open ? (
        <div className="integrations-body">
          {pending.length > 0 ? (
            <button
              type="button"
              className="integration-action"
              disabled={busy !== null}
              onClick={integrations.connectAll}
            >
              {busy === 'all' ? 'registering…' : `register ${pending.length} with ZERO`}
            </button>
          ) : null}

          <ul className="integration-list">
            {statuses.map((status) => (
              <IntegrationRow
                key={status.integration.id}
                status={status}
                busy={busy === status.integration.id}
                disabled={busy !== null}
                expanded={expanded === status.integration.id}
                browser={status.integration.id === ZERO_BROWSER.id ? browser : null}
                onToggle={() =>
                  setExpanded((current) =>
                    current === status.integration.id ? null : status.integration.id,
                  )
                }
                onConnect={() => integrations.connect(status.integration.id)}
                onAuthorize={() => integrations.authorize(status.integration.id)}
                onRemove={() => integrations.remove(status.integration.id)}
              />
            ))}
          </ul>

          {authorizationUrl ? (
            <p className="integration-auth">
              <a href={authorizationUrl.url} target="_blank" rel="noreferrer noopener">
                open the authorization page for {authorizationUrl.id}
              </a>{' '}
              <button type="button" className="link-button" onClick={integrations.dismissAuthorization}>
                dismiss
              </button>
            </p>
          ) : null}

          {notice ? <p className="dim">{notice}</p> : null}
          {error ? <p className="warn">{error}</p> : null}
          <button type="button" className="link-button" onClick={integrations.refresh}>
            refresh
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface RowProps {
  status: IntegrationStatus;
  busy: boolean;
  disabled: boolean;
  expanded: boolean;
  /** Set only for the ZERO Browser row. */
  browser: BrowserBridgeApi | null;
  onToggle: () => void;
  onConnect: () => void;
  onAuthorize: () => void;
  onRemove: () => void;
}

function IntegrationRow({
  status,
  busy,
  disabled,
  expanded,
  browser,
  onToggle,
  onConnect,
  onAuthorize,
  onRemove,
}: RowProps): React.JSX.Element {
  const { integration, state, server, toolCount } = status;
  const needsWrite = state === 'notConfigured' || state === 'outdated' || state === 'disabled';

  return (
    <li className={`integration integration-${state}`}>
      <button type="button" className="integration-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="integration-name">{integration.name}</span>
        <span className={`integration-state state-${state}`}>{STATE_LABEL[state]}</span>
        {server ? <span className="dim">{toolCount} tools</span> : null}
      </button>

      {expanded ? (
        <div className="integration-detail">
          <p>{integration.description}</p>
          <p className="dim">
            {integration.vendor} · {integration.official ? 'official server' : 'community server'} ·{' '}
            <a href={integration.docsUrl} target="_blank" rel="noreferrer noopener">
              docs
            </a>
          </p>

          <ul className="integration-capabilities">
            {integration.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>

          {integration.requirements.length > 0 ? (
            <>
              <p className="integration-subhead">needs</p>
              <ul className="integration-requirements">
                {integration.requirements.map((requirement) => (
                  <li key={requirement.name}>
                    <code>{requirement.name}</code>{' '}
                    <span className="dim">({requirement.kind})</span> — {requirement.description}
                    {requirement.href ? (
                      <>
                        {' '}
                        <a href={requirement.href} target="_blank" rel="noreferrer noopener">
                          where
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {browser ? <BrowserControls browser={browser} /> : null}

          {status.differences.length > 0 ? (
            <p className="dim">
              ZERO has a different configuration for: {status.differences.join(', ')}
            </p>
          ) : null}

          <div className="integration-actions">
            {needsWrite ? (
              <button type="button" className="integration-action" disabled={disabled} onClick={onConnect}>
                {busy ? 'registering…' : state === 'outdated' ? 'update entry' : 'register with ZERO'}
              </button>
            ) : null}
            {integration.requiresOAuth && state !== 'notConfigured' ? (
              <button
                type="button"
                className="integration-action"
                disabled={disabled}
                onClick={onAuthorize}
              >
                {busy ? 'starting…' : 'sign in'}
              </button>
            ) : null}
            {state !== 'notConfigured' ? (
              <button type="button" className="link-button" disabled={disabled} onClick={onRemove}>
                remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The browsers this machine really has, and the one that is running. This is
 * what ZERO's internet access is made of, so it is shown as facts from the
 * gateway rather than as a claim that "the browser is connected".
 */
function BrowserControls({ browser }: { browser: BrowserBridgeApi }): React.JSX.Element {
  const { status, gatewayReachable, busy } = browser;

  if (!gatewayReachable) {
    return (
      <p className="dim">
        No gateway on this origin — start it with <code>npm run gateway</code> to give ZERO a
        browser.
      </p>
    );
  }

  if (!status) return <p className="dim">asking the gateway…</p>;

  const installed = status.browsers.filter((entry) => entry.installed);

  return (
    <div className="browser-controls">
      <p className="integration-subhead">browsers on this machine</p>
      <ul className="integration-requirements">
        {status.browsers.map((entry) => (
          <li key={entry.id}>
            <code>{entry.name}</code>{' '}
            <span className="dim">
              ({entry.protocol}) —{' '}
              {entry.installed ? (entry.executable ?? 'installed') : 'not installed'}
            </span>
            {status.active?.id === entry.id ? <span className="integration-state state-connected"> running</span> : null}
          </li>
        ))}
      </ul>

      <p className="dim">
        {status.active
          ? `${status.active.name} is running on debugging port ${status.active.port}.`
          : 'No browser is running.'}{' '}
        Local and private addresses are {status.allowPrivate ? 'ALLOWED' : 'refused'}.
      </p>

      <div className="integration-actions">
        {installed.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="integration-action"
            disabled={busy}
            onClick={() => browser.launch(entry.id)}
          >
            {status.active?.id === entry.id ? `restart ${entry.id}` : `start ${entry.id}`}
          </button>
        ))}
        {status.active ? (
          <button type="button" className="link-button" disabled={busy} onClick={browser.close}>
            close browser
          </button>
        ) : null}
        <button type="button" className="link-button" disabled={busy} onClick={browser.refresh}>
          refresh
        </button>
      </div>

      {installed.length === 0 ? (
        <p className="warn">
          None of Chrome, Firefox, Brave or Edge was found. Install one, or point{' '}
          <code>ZERO_BROWSER_&lt;ID&gt;_PATH</code> at it.
        </p>
      ) : null}

      {browser.error ? <p className="warn">{browser.error}</p> : null}
    </div>
  );
}
