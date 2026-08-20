/**
 * Agent registry — the single source of truth for "which agents exist".
 *
 * The agents are the real repositories on the machine ZERO runs on. They are
 * discovered *through ZERO itself* (`command/exec`, inside ZERO's sandbox) —
 * the interface never reads a filesystem and never carries a hardcoded list:
 *
 *   1. `<root>/zero-agents.json` — an optional manifest that adds the metadata
 *      a directory cannot know (id, role, capabilities, inputs, outputs).
 *   2. the directories under `<root>` that are git repositories, together with
 *      the evidence needed to classify them (entrypoints, agent instructions,
 *      package metadata, frontend/MCP/ZERO markers).
 *
 * The same list feeds the graph *and* ZERO's routing decision, so picture and
 * orchestration can never disagree. A repository is only an agent when the
 * evidence says so — a name is not evidence. What ZERO cannot see is reported
 * as an error; nothing is invented.
 */
import type { ZeroClient } from './client';
import {
  childAgentForId,
  childAgentForRepo,
  isExcludedRepository,
  type Department,
} from './agentPolicy';
import {
  classifyRepository,
  type ClassifiedRepository,
  type RepositoryClassification,
  type RepositoryEvidence,
} from './agentClassifier';

export interface ZeroAgent {
  /** Stable id: the manifest id, otherwise the directory name. */
  id: string;
  name: string;
  role?: string;
  description?: string;
  capabilities?: string[];
  inputs?: string[];
  outputs?: string[];
  /** Absolute path of the agent repository — this is how ZERO addresses it. */
  cwd: string;
  repository?: string;
  branch?: string;
  /** Agent instructions the repository ships (AGENTS.md / CLAUDE.md / .codex). */
  hasInstructions?: boolean;
  enabled: boolean;
  /** Where this entry came from. */
  source: 'manifest' | 'scan';
  /** What the classifier decided this repository is. */
  classification: RepositoryClassification;
  /** Why it was classified that way — shown in the UI, never invented. */
  classificationReason: string;
  /** True when ZERO can hand this workspace a task. */
  callable: boolean;
  /** How ZERO invokes it — the real mechanism, not a label. */
  invocationMethod: string;
  /** Business department, from the operator's agent policy. */
  department?: Department;
  /** Capabilities that always require explicit human approval. */
  requiresApprovalFor?: string[];
}

export interface AgentRegistryResult {
  /** Repositories classified as agents (the only ones drawn as agent nodes). */
  agents: ZeroAgent[];
  /** Everything the scan found, including non-agents, with the reason. */
  repositories: ClassifiedRepository[];
  /** Repositories the policy blocks outright (never rendered, never routed). */
  excluded: string[];
  source: 'manifest' | 'scan' | 'none';
  /** Human-readable reason when discovery could not run. */
  error?: string;
  root: string;
}

export interface AgentRegistryOptions {
  root: string;
  manifestPath: string;
  execSandbox: 'readOnly' | 'externalSandbox' | 'workspaceWrite';
  timeoutMs?: number;
}

interface CommandExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** ASCII start-of-heading: safe inside paths, remotes and README headlines. */
const FIELD_SEPARATOR = '\u0001';

export const INVOCATION_METHOD = 'ZERO thread/start + turn/start in the agent workspace';

/**
 * One read-only command emits the manifest (if any) and the classified scan in
 * a single round trip, so discovery stays cheap enough to poll.
 */
export function buildDiscoveryScript(root: string, manifestPath: string): string {
  const quotedRoot = shellQuote(root);
  const quotedManifest = shellQuote(manifestPath);
  return [
    `if [ -f ${quotedManifest} ]; then echo "__MANIFEST__"; cat ${quotedManifest}; echo; fi;`,
    `echo "__SCAN__";`,
    `for dir in ${quotedRoot}/*/; do`,
    `  [ -d "$dir/.git" ] || continue;`,
    `  name=$(basename "$dir");`,
    `  remote=$(git -C "$dir" remote get-url origin 2>/dev/null);`,
    `  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null);`,
    `  headline=$(head -n 20 "$dir/README.md" 2>/dev/null | grep -m1 -v '^\\s*$' | sed 's/^#\\+ *//');`,
    `  instructions=no;`,
    `  { [ -f "$dir/AGENTS.md" ] || [ -f "$dir/CLAUDE.md" ] || [ -d "$dir/.codex" ]; } && instructions=yes;`,
    `  pkgname=""; bin=no; entry=no; mcp=no; frontend=no; zero=no;`,
    `  if [ -f "$dir/package.json" ]; then`,
    `    pkgname=$(grep -m1 '"name"' "$dir/package.json" | sed 's/.*: *"\\(.*\\)".*/\\1/');`,
    `    grep -q '"bin"' "$dir/package.json" && bin=yes;`,
    `    grep -qE '"(start|dev|serve)" *:' "$dir/package.json" && entry=yes;`,
    `    grep -qE 'modelcontextprotocol|mcpName' "$dir/package.json" && mcp=yes;`,
    `  fi;`,
    `  { [ -f "$dir/main.py" ] || [ -f "$dir/app.py" ] || [ -f "$dir/pyproject.toml" ]; } && entry=yes;`,
    `  [ -f "$dir/Cargo.toml" ] && entry=yes;`,
    `  { [ -f "$dir/index.html" ] && ls "$dir" | grep -qE '^(vite|next|astro|svelte)\\.config'; } && frontend=yes;`,
    `  { [ -d "$dir/codex-rs/app-server" ] || [ -f "$dir/codex-rs/Cargo.toml" ]; } && zero=yes;`,
    `  printf '%s\\001%s\\001%s\\001%s\\001%s\\001%s\\001%s\\001%s\\001%s\\001%s\\001%s\\001%s\\n' "$name" "\${dir%/}" "$remote" "$branch" "$headline" "$instructions" "$pkgname" "$bin" "$entry" "$mcp" "$frontend" "$zero";`,
    `done`,
  ].join(' ');
}

export async function loadAgents(
  client: ZeroClient,
  options: AgentRegistryOptions,
): Promise<AgentRegistryResult> {
  if (!options.root) {
    return {
      agents: [],
      repositories: [],
      excluded: [],
      source: 'none',
      root: '',
      error: 'VITE_ZERO_AGENT_ROOT is not set — ZERO was not told where the agents live.',
    };
  }

  const script = buildDiscoveryScript(options.root, options.manifestPath);
  let response: CommandExecResponse;
  try {
    response = await client.request<CommandExecResponse>('command/exec', {
      command: ['bash', '-lc', script],
      cwd: options.root,
      sandboxPolicy: sandboxPolicyFor(options.execSandbox),
      timeoutMs: options.timeoutMs ?? 20_000,
    });
  } catch (error) {
    return {
      agents: [],
      repositories: [],
      excluded: [],
      source: 'none',
      root: options.root,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.exitCode !== 0) {
    return {
      agents: [],
      repositories: [],
      excluded: [],
      source: 'none',
      root: options.root,
      error: `agent discovery exited with ${response.exitCode}: ${response.stderr.slice(0, 200)}`,
    };
  }

  return parseDiscoveryOutput(response.stdout, options.root);
}

/** Pure parser + classifier (unit-tested against ZERO's real output format). */
export function parseDiscoveryOutput(stdout: string, root: string): AgentRegistryResult {
  const manifestStart = stdout.indexOf('__MANIFEST__');
  const scanStart = stdout.indexOf('__SCAN__');
  const manifestText =
    manifestStart >= 0 && scanStart > manifestStart
      ? stdout.slice(manifestStart + '__MANIFEST__'.length, scanStart)
      : '';
  const scanText = scanStart >= 0 ? stdout.slice(scanStart + '__SCAN__'.length) : stdout;

  const scanned = parseScan(scanText);
  // Hard exclusion first: these repositories never reach the classifier, the
  // graph, the routing roster or the invocation layer.
  const excluded = scanned.filter((entry) => isExcludedRepository(entry.name)).map((entry) => entry.name);
  const repositories = scanned
    .filter((entry) => !isExcludedRepository(entry.name))
    .map((entry) => ({
    ...classifyRepository(entry),
    ...(entry.repository ? { repository: entry.repository } : {}),
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.description ? { description: entry.description } : {}),
  }));
  const manifest = parseManifest(manifestText).filter(
    (entry) => !isExcludedRepository(entry.name) && !isExcludedRepository(basename(entry.cwd)),
  );
  const byPath = new Map(repositories.map((entry) => [normalizePath(entry.cwd), entry]));
  const byName = new Map(repositories.map((entry) => [entry.name.toLowerCase(), entry]));

  if (manifest.length > 0) {
    // The manifest declares the agents explicitly; the scan supplies the disk
    // facts. An operator declaration outranks the classifier heuristics.
    const agents = manifest.map((entry): ZeroAgent => {
      const match = byPath.get(normalizePath(entry.cwd)) ?? byName.get(entry.name.toLowerCase());
      const definition = childAgentForId(entry.id) ?? childAgentForRepo(entry.name);
      return {
        ...entry,
        ...(definition
          ? {
              department: definition.department,
              requiresApprovalFor: [...definition.requiresApprovalFor],
            }
          : {}),
        ...(entry.repository ?? match?.repository
          ? { repository: entry.repository ?? match?.repository }
          : {}),
        ...(entry.branch ?? match?.branch ? { branch: entry.branch ?? match?.branch } : {}),
        hasInstructions: entry.hasInstructions ?? match?.agentInstructions,
        classificationReason: match
          ? `declared in the manifest; scan says: ${match.reason}`
          : 'declared in the manifest',
      };
    });
    return { agents, repositories, excluded, source: 'manifest', root };
  }

  const agents: ZeroAgent[] = [];
  for (const entry of repositories) {
    const definition = childAgentForRepo(entry.name);
    if (!definition) continue;
    agents.push({
      id: definition.id,
      name: definition.displayName,
      cwd: entry.cwd,
      enabled: true,
      source: 'scan',
      classification: 'agent',
      classificationReason: `child agent of HWD-ZERO (${entry.reason})`,
      callable: true,
      invocationMethod: INVOCATION_METHOD,
      department: definition.department,
      requiresApprovalFor: [...definition.requiresApprovalFor],
      hasInstructions: entry.agentInstructions,
      ...(entry.repository ? { repository: entry.repository } : {}),
      ...(entry.branch ? { branch: entry.branch } : {}),
      ...(entry.description ? { description: entry.description } : {}),
    });
  }

  return { agents, repositories, excluded, source: agents.length > 0 ? 'scan' : 'none', root };
}

function parseManifest(text: string): ZeroAgent[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { agents?: unknown }).agents)
      ? (parsed as { agents: unknown[] }).agents
      : [];

  const agents: ZeroAgent[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const cwd = typeof record['cwd'] === 'string' ? record['cwd'] : '';
    const name =
      typeof record['name'] === 'string' && record['name'].trim().length > 0
        ? record['name']
        : basename(cwd);
    const id = typeof record['id'] === 'string' && record['id'].length > 0 ? record['id'] : name;
    if (!cwd || !name) continue;
    const enabled = record['enabled'] !== false;
    agents.push({
      id,
      name,
      cwd,
      enabled,
      source: 'manifest',
      classification: 'agent',
      classificationReason: 'declared in the manifest',
      callable: enabled,
      invocationMethod: INVOCATION_METHOD,
      ...(typeof record['role'] === 'string' ? { role: record['role'] } : {}),
      ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
      ...(stringArray(record['capabilities'])
        ? { capabilities: stringArray(record['capabilities']) }
        : {}),
      ...(stringArray(record['inputs']) ? { inputs: stringArray(record['inputs']) } : {}),
      ...(stringArray(record['outputs']) ? { outputs: stringArray(record['outputs']) } : {}),
      ...(typeof record['repository'] === 'string' ? { repository: record['repository'] } : {}),
    });
  }
  return agents;
}

interface ScannedRepository extends RepositoryEvidence {
  repository?: string;
  branch?: string;
  description?: string;
}

function parseScan(text: string): ScannedRepository[] {
  const entries: ScannedRepository[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split(FIELD_SEPARATOR);
    if (parts.length < 2) continue;
    const [
      name,
      cwd,
      repository,
      branch,
      headline,
      instructions,
      packageName,
      bin,
      entry,
      mcp,
      frontend,
      zero,
    ] = parts;
    if (!name || !cwd) continue;
    entries.push({
      name,
      cwd,
      agentInstructions: instructions === 'yes',
      hasBin: bin === 'yes',
      hasEntrypoint: entry === 'yes',
      mcpServer: mcp === 'yes',
      frontend: frontend === 'yes',
      zeroRuntime: zero === 'yes',
      ...(packageName ? { packageName } : {}),
      ...(repository ? { repository } : {}),
      ...(branch ? { branch } : {}),
      ...(headline ? { description: headline } : {}),
    });
  }
  return entries;
}

function sandboxPolicyFor(mode: AgentRegistryOptions['execSandbox']): Record<string, unknown> {
  if (mode === 'externalSandbox') return { type: 'externalSandbox', networkAccess: 'restricted' };
  if (mode === 'workspaceWrite') return { type: 'workspaceWrite' };
  return { type: 'readOnly' };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length > 0 ? entries : undefined;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? '';
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
