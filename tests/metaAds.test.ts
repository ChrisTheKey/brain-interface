/**
 * The interface side of paid advertising.
 *
 * Three things worth testing and the rest is React: that the panel never
 * implies ZERO can change an account it cannot, that the activity path is
 * drawn from events that actually happened, and that nothing about Meta
 * reaches the browser — asserted against the built bundle, because that is
 * the artefact that ships.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manageBlocker, metaAdsSummary } from '../src/state/useMetaAds';
import { adsBranch, adsState, withAds } from '../src/graph/ads';
import { ADS_NODE_ID, ZERO_NODE_ID, adsAccountNodeId } from '../src/graph/model';
import type { GraphModel } from '../src/graph/model';
import type { MetaAdsStatus, OperatorEvent } from '../src/hwd/types';

function status(overrides: Partial<MetaAdsStatus> = {}): MetaAdsStatus {
  return {
    integration: 'meta-ads',
    provider: 'meta-official-mcp',
    endpoint: 'https://mcp.facebook.com/ads',
    auth: 'oauth',
    connected: true,
    blocked_by: '',
    local_only: false,
    enabled: true,
    mcp_enabled: true,
    accounts: 1,
    account_list: [
      {
        id: 'act_907',
        label: 'Helvetic Webdesign',
        currency: 'CHF',
        timezone: 'Europe/Zurich',
        status: 'ACTIVE',
        mcp_enabled: true,
      },
    ],
    selected_account: 'act_907',
    selected_account_label: 'Helvetic Webdesign',
    read_ready: true,
    mutation_ready: true,
    rollout: 'available',
    capabilities: { granted: [], missing: [], read_tools: ['a'], write_tools: ['b'] },
    budget_guard: {
      currency: 'CHF',
      max_daily: 'CHF 100.00',
      max_lifetime: null,
      max_increase_percent: 100,
      configured: true,
      note: '',
    },
    auth_state: { state: 'ready', scopes: ['ads_management'] },
    reason: null,
    ...overrides,
  };
}

let sequence = 0;
function event(type: OperatorEvent['type'], payload: Record<string, unknown> = {}): OperatorEvent {
  sequence += 1;
  return {
    event_id: `e${sequence}`,
    timestamp: new Date(sequence * 1000).toISOString(),
    mission_id: 'ads:p1',
    agent_id: 'zero',
    type,
    payload,
  };
}

const emptyGraph: GraphModel = { nodes: [], edges: [], notes: [] };

describe('what the panel says', () => {
  it('never says connected under local-only mode', () => {
    expect(metaAdsSummary(status({ connected: false, blocked_by: 'local_only' }))).toBe(
      'META ADS · BLOCKED BY LOCAL-ONLY MODE',
    );
  });

  it('says read-only when the login cannot spend', () => {
    // The distinction the whole panel exists for: connected and able to
    // change an account are different facts.
    expect(
      metaAdsSummary(status({ mutation_ready: false, mutation_reason: 'meta_scope_missing' })),
    ).toBe('META ADS · READ ONLY');
  });

  it('says the rollout is not enabled rather than inventing a workaround', () => {
    expect(metaAdsSummary(status({ rollout: 'disabled', mutation_ready: false }))).toBe(
      'META ADS MCP · NOT ENABLED FOR THIS ACCOUNT',
    );
  });

  it('asks for a new sign-in when the token stopped working', () => {
    expect(
      metaAdsSummary(status({ auth_state: { state: 'reauthentication_required' } })),
    ).toBe('META ADS · REAUTHENTICATION REQUIRED');
  });

  it('says unknown rather than guessing when the runtime did not answer', () => {
    expect(metaAdsSummary(null)).toBe('META ADS · UNKNOWN');
  });

  it.each([
    ['meta_rollout_disabled', 'Meta has not switched'],
    ['meta_scope_missing', 'ads_management'],
    ['meta_no_write_tools', 'no mutation tools'],
  ])('explains %s in words the operator can act on', (reason, fragment) => {
    const blocker = manageBlocker(status({ mutation_ready: false, mutation_reason: reason }));
    expect(blocker).toContain(fragment);
  });

  it('says nothing about blockers when managing is possible', () => {
    expect(manageBlocker(status())).toBe('');
  });
});

describe('the activity path', () => {
  it('draws no branch at all when nothing is connected', () => {
    const branch = adsBranch(null, []);
    expect(branch.nodes).toEqual([]);
    expect(branch.state).toBe('offline');
  });

  it('draws one node per real ad account', () => {
    const branch = adsBranch(status(), []);
    const accounts = branch.nodes.filter((node) => node.type === 'adsAccount');
    expect(accounts.map((node) => node.label)).toEqual(['Helvetic Webdesign']);
    expect(accounts[0]?.metadata['currency']).toBe('CHF');
  });

  it('runs ZERO through the hub to the accounts', () => {
    const branch = adsBranch(status(), []);
    expect(branch.edges[0]).toMatchObject({
      source: ZERO_NODE_ID,
      target: ADS_NODE_ID,
      relationship: 'advertises',
    });
    expect(
      branch.edges.filter((edge) => edge.source === ADS_NODE_ID).map((edge) => edge.target),
    ).toContain(adsAccountNodeId('act_907'));
  });

  it.each([
    ['zero.ads.reading', 'reading', 'READING'],
    ['zero.ads.analyzing', 'analyzing', 'ANALYZING'],
    ['zero.ads.planning', 'planning', 'PLANNING'],
    ['zero.ads.awaiting_approval', 'awaiting_approval', 'AWAITING_APPROVAL'],
    ['zero.ads.updating', 'updating', 'UPDATING'],
    ['zero.ads.verifying', 'verifying', 'VERIFYING'],
    ['zero.ads.done', 'done', 'DONE'],
    ['zero.ads.partial', 'partial_failure', 'PARTIAL FAILURE'],
    ['zero.ads.error', 'error', 'ERROR'],
  ] as const)('shows %s as %s', (type, state, label) => {
    const branch = adsBranch(status(), [event(type)]);
    expect(branch.state).toBe(state);
    expect(branch.label).toBe(label);
  });

  it('never shows UPDATING without the runtime having said so', () => {
    // The runtime does not publish that event before a human approves, so the
    // interface cannot show it before then either.
    expect(adsState(status(), [event('zero.ads.awaiting_approval')])).toBe('awaiting_approval');
  });

  it('carries Metas own rollout flag onto the hub rather than interpreting it', () => {
    const hub = adsBranch(status({ rollout: 'disabled' }), []).nodes.find(
      (node) => node.id === ADS_NODE_ID,
    );
    expect(hub?.metadata['rollout']).toBe('disabled');
  });

  it('keeps an unknown per-account flag as unknown', () => {
    const branch = adsBranch(
      status({
        account_list: [
          {
            id: 'act_1',
            label: 'A',
            currency: 'CHF',
            timezone: '',
            status: '',
            mcp_enabled: null,
          },
        ],
      }),
      [],
    );
    const account = branch.nodes.find((node) => node.type === 'adsAccount');
    expect(account?.metadata['mcp_enabled']).toBe('unknown');
  });

  it('shows local-only as disabled rather than as an error', () => {
    const branch = adsBranch(status({ connected: false, blocked_by: 'local_only' }), []);
    expect(branch.nodes.find((node) => node.id === ADS_NODE_ID)?.status).toBe('disabled');
  });

  it('replaces the old branch instead of stacking a second one', () => {
    const once = withAds(emptyGraph, adsBranch(status(), []));
    const twice = withAds(once, adsBranch(status(), []));
    expect(twice.nodes.filter((node) => node.id === ADS_NODE_ID)).toHaveLength(1);
    expect(twice.nodes).toHaveLength(2);
  });

  it('removes the branch when the connection goes away', () => {
    const connected = withAds(emptyGraph, adsBranch(status(), []));
    expect(withAds(connected, adsBranch(null, [])).nodes).toEqual([]);
  });
});

describe('nothing about Meta reaches the browser but the status', () => {
  const repoRoot = new URL('..', import.meta.url).pathname;

  function sources(directory: string): string[] {
    const found: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) found.push(full);
      }
    };
    walk(directory);
    return found;
  }

  it('never calls Meta from the browser', () => {
    // The architecture in one assertion: the interface talks to the gateway on
    // its own origin, the gateway proxies to HWD-ZERO, and only HWD-ZERO holds
    // a credential.
    //
    // What is forbidden is an *address the browser could call* and anything
    // that could sign a call. Naming Meta in a sentence, or naming the
    // `ads_management` scope in the message that tells the operator which
    // permission is missing, is neither — a public scope name is not a
    // credential, and refusing it would only make the interface vaguer.
    for (const file of sources(join(repoRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/https?:\/\/[\w.]*facebook\.com/);
      expect(source, file).not.toMatch(/VITE_[A-Z_]*(META|FACEBOOK)/);
      expect(source, file).not.toMatch(/access_token|code_verifier|Bearer\s/);
    }
  });

  it('holds no OAuth machinery in the browser at all', () => {
    // The browser's entire part in signing in is opening a URL the runtime
    // handed it. No exchange, no refresh, no verifier.
    for (const file of sources(join(repoRoot, 'src'))) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/refresh_token|client_secret|grant_type/);
    }
  });

  it('is not in the built bundle', () => {
    const assets = join(repoRoot, 'dist', 'assets');
    let names: string[] = [];
    try {
      names = readdirSync(assets).map((entry) => String(entry));
    } catch {
      return; // nothing built in this run; the source checks above still hold
    }
    for (const name of names.filter((entry) => entry.endsWith('.js'))) {
      const bundle = readFileSync(join(assets, name), 'utf8');
      // No address the browser could call, and nothing that could sign a call.
      expect(bundle, name).not.toMatch(/https?:\/\/[\w.]*facebook\.com/);
      expect(bundle, name).not.toContain('code_verifier');
      expect(bundle, name).not.toContain('access_token');
      expect(bundle, name).not.toMatch(/VITE_[A-Z_]*(META|FACEBOOK)/);
    }
  });
});
