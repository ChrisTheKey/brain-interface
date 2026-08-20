/**
 * Repository classification.
 *
 * A repository is not an agent because of its name. The classifier decides
 * from evidence that ZERO collected on disk (entrypoints, agent instructions,
 * package metadata, project files) what a repository actually is:
 *
 *   zero          the ZERO runtime itself (orchestrator, not an agent)
 *   interface     a frontend/UI (this brain, for example)
 *   toolProvider  an MCP server — a tool ZERO uses, not an agent it runs
 *   agent         an operative workspace ZERO can hand a task to
 *   library       code without an entrypoint and without agent instructions
 *
 * Only `agent` becomes an agent node. Everything else is reported with its
 * classification so nothing silently disappears — and nothing is upgraded to
 * "agent" without evidence.
 */

export type RepositoryClassification =
  | 'zero'
  | 'interface'
  | 'toolProvider'
  | 'agent'
  | 'library';

export interface RepositoryEvidence {
  name: string;
  cwd: string;
  /** AGENTS.md / CLAUDE.md / .codex present. */
  agentInstructions: boolean;
  /** package.json "name" field, when present. */
  packageName?: string;
  /** package.json declares a bin entry. */
  hasBin: boolean;
  /** package.json has a start/dev script, a main.py, or a Cargo binary. */
  hasEntrypoint: boolean;
  /** Depends on the MCP SDK or declares an `mcpName`. */
  mcpServer: boolean;
  /** index.html + a vite/next config → a frontend. */
  frontend: boolean;
  /** Contains the ZERO agent runtime (codex app-server sources or binary). */
  zeroRuntime: boolean;
}

export interface ClassifiedRepository extends RepositoryEvidence {
  /** Git remote of the checkout, when it has one. */
  repository?: string;
  /** Checked-out branch. */
  branch?: string;
  /** README headline, when the repository has one. */
  description?: string;
  classification: RepositoryClassification;
  /** Why the classifier decided this — shown in the UI, never invented. */
  reason: string;
  /** True only for repositories ZERO can actually be told to work in. */
  callable: boolean;
}

export function classifyRepository(evidence: RepositoryEvidence): ClassifiedRepository {
  const base = { ...evidence };

  if (evidence.zeroRuntime) {
    return {
      ...base,
      classification: 'zero',
      reason: 'contains the ZERO agent runtime (app-server) — this is ZERO, not an agent',
      callable: false,
    };
  }

  if (evidence.mcpServer) {
    return {
      ...base,
      classification: 'toolProvider',
      reason: 'MCP server — ZERO uses it as a tool, it is not an agent workspace',
      callable: false,
    };
  }

  if (evidence.frontend && !evidence.agentInstructions) {
    return {
      ...base,
      classification: 'interface',
      reason: 'frontend project (index.html + bundler config) without agent instructions',
      callable: false,
    };
  }

  if (evidence.agentInstructions) {
    return {
      ...base,
      classification: 'agent',
      reason: 'ships agent instructions (AGENTS.md / CLAUDE.md / .codex)',
      callable: true,
    };
  }

  if (evidence.hasEntrypoint || evidence.hasBin) {
    return {
      ...base,
      classification: 'agent',
      reason: 'runnable workspace with an entrypoint ZERO can operate in',
      callable: true,
    };
  }

  return {
    ...base,
    classification: 'library',
    reason: 'no entrypoint and no agent instructions found',
    callable: false,
  };
}

export function summarizeClassifications(repositories: ClassifiedRepository[]): string[] {
  const notes: string[] = [];
  const byClass = new Map<RepositoryClassification, string[]>();
  for (const repository of repositories) {
    const list = byClass.get(repository.classification) ?? [];
    list.push(repository.name);
    byClass.set(repository.classification, list);
  }
  for (const [classification, names] of byClass) {
    if (classification === 'agent') continue;
    notes.push(`Not shown as agents (${classification}): ${names.sort().join(', ')}`);
  }
  return notes;
}
