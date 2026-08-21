/**
 * Which child agents are actually there.
 *
 * The panel used to show "6 REGISTERED" next to a policy that names eight, and
 * the six were not child agents at all — they were HWD-ZERO's own roles
 * (`zero`, `codex`, `claude-code`, `perplexity`, `checkmate`, `pulse`), read
 * from the brain registry. Two different populations under one label.
 *
 * The real child agents live on disk under the agent root. Discovery used to
 * run through the codex app-server's `command/exec`, so with codex absent —
 * the normal state on a phone — none were ever found and the role registry was
 * all that was left to display. HWD-ZERO discovers them now, because HWD-ZERO
 * is the runtime.
 *
 * The split of responsibility is deliberate: the runtime reports *facts* (what
 * directories exist, what they look like), and this module applies *policy*
 * (`agentPolicy.ts` — the eight allowed, the four excluded). Policy stays in
 * one place, so the two can never disagree about which repositories are
 * permitted.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CHILD_AGENTS, childAgentForRepo, isExcludedRepository } from '../zero/agentPolicy';
import type { HwdZeroClient } from '../hwd/client';
import type { ChildAgentDefinition } from '../zero/agentPolicy';
import type { DiscoveredRepository } from '../hwd/types';

export interface ChildAgentView {
  /** How many of the allowed agents were genuinely found. */
  discovered: number;
  /** How many the policy allows. Always the full list, never a moving target. */
  allowed: number;
  /** Repository names the policy expects and the runtime did not find. */
  missing: string[];
  /** The agents that are present, with their policy definition. */
  present: ChildAgentDefinition[];
  /** Where the runtime looked. Empty before it has answered. */
  root: string;
  /** False when the agent root itself does not exist — a different problem. */
  rootExists: boolean;
  /** Null until the first answer; the panel shows "discovering" until then. */
  loaded: boolean;
  refresh: () => void;
}

/**
 * Does this directory plausibly hold a runnable agent?
 *
 * A bare directory with nothing in it is not an agent, and counting it would
 * make the tally look complete when it is not. A checkout or any recognisable
 * project marker is enough — deciding whether the adapter actually works is
 * ZERO's job at invocation time, not a guess made from a file listing.
 */
export function looksRunnable(repository: DiscoveredRepository): boolean {
  return repository.is_git || repository.markers.length > 0;
}

/**
 * Reconcile what the runtime found against what the policy allows.
 *
 * Pure, so the reconciliation is testable without a server: the interesting
 * cases are all about which side of the comparison something falls on.
 */
export function reconcile(repositories: DiscoveredRepository[]): {
  present: ChildAgentDefinition[];
  missing: string[];
} {
  const present: ChildAgentDefinition[] = [];
  for (const repository of repositories) {
    // The four hard exclusions are refused before anything else, exactly as
    // they are everywhere else in the system.
    if (isExcludedRepository(repository.name)) continue;
    if (!looksRunnable(repository)) continue;
    const definition = childAgentForRepo(repository.name);
    if (definition && !present.includes(definition)) present.push(definition);
  }
  const found = new Set(present.map((agent) => agent.id));
  return {
    present,
    missing: CHILD_AGENTS.filter((agent) => !found.has(agent.id)).map((agent) => agent.repo),
  };
}

export function useChildAgents(client: HwdZeroClient, enabled: boolean): ChildAgentView {
  const [state, setState] = useState<{
    present: ChildAgentDefinition[];
    missing: string[];
    root: string;
    rootExists: boolean;
    loaded: boolean;
  }>({ present: [], missing: [], root: '', rootExists: false, loaded: false });
  const [nonce, setNonce] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return undefined;

    void (async () => {
      try {
        const discovery = await client.childAgents();
        if (!mounted.current) return;
        const { present, missing } = reconcile(discovery.repositories ?? []);
        setState({
          present,
          missing,
          root: discovery.root ?? '',
          rootExists: discovery.exists === true,
          loaded: true,
        });
      } catch {
        // A runtime that cannot answer is not the same as an empty workspace,
        // so nothing is claimed: `loaded` stays false and the panel says so.
        if (mounted.current) setState((current) => ({ ...current, loaded: false }));
      }
    })();

    return () => {
      mounted.current = false;
    };
  }, [client, enabled, nonce]);

  return {
    discovered: state.present.length,
    allowed: CHILD_AGENTS.length,
    missing: state.missing,
    present: state.present,
    root: state.root,
    rootExists: state.rootExists,
    loaded: state.loaded,
    refresh,
  };
}
