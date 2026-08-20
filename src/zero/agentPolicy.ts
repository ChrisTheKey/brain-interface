/**
 * Agent policy: which repositories may become child agents, and which must
 * never appear — no matter what a scan or a manifest says.
 *
 * The operator (you) defines this list, not a heuristic and not a model. It is
 * the one place where "is this repository part of the agent network?" is
 * answered, so the graph, the routing roster and the invocation layer can
 * never disagree about it.
 */

export type Department =
  | 'orchestration'
  | 'acquisition'
  | 'social'
  | 'reputation'
  | 'infrastructure'
  | 'outreach'
  | 'seo'
  | 'funnel';

export interface ChildAgentDefinition {
  id: string;
  displayName: string;
  /** Repository directory name, exactly as it exists on disk. */
  repo: string;
  department: Department;
  /** Capabilities that always need explicit human approval for this agent. */
  requiresApprovalFor: string[];
}

/**
 * The child agents of HWD-ZERO. `parent` is always ZERO — the interface never
 * introduces another parent.
 */
export const CHILD_AGENTS: readonly ChildAgentDefinition[] = [
  {
    id: 'lead_scraper',
    displayName: 'Autonomous Website Lead Scraper',
    repo: 'Autonomous-Website-Lead-Scraper',
    department: 'acquisition',
    requiresApprovalFor: ['network.write', 'external.message'],
  },
  {
    id: 'meta',
    displayName: 'Meta Agent',
    repo: 'Meta-Agent',
    department: 'orchestration',
    requiresApprovalFor: ['agent.invoke', 'repo.write'],
  },
  {
    id: 'agent_installer',
    displayName: 'Auto Agent Install Helper',
    repo: 'Auto-Agent-Install-Helper',
    department: 'infrastructure',
    requiresApprovalFor: ['system.install', 'repo.write'],
  },
  {
    id: 'google_reviews',
    displayName: 'Google Bewertungen AI Agent',
    repo: 'Google-Bewertungen-AI-Agent',
    department: 'reputation',
    requiresApprovalFor: ['external.publish', 'external.message'],
  },
  {
    id: 'insta',
    displayName: 'Insta Agent',
    repo: 'Insta-Agent',
    department: 'social',
    requiresApprovalFor: ['external.publish', 'external.message'],
  },
  {
    id: 'website_outreach',
    displayName: 'Autonomer Website Outreach Agent',
    repo: 'Autonomer-Website-Outreach-Agent',
    department: 'outreach',
    requiresApprovalFor: ['external.message'],
  },
  {
    id: 'seo',
    displayName: 'SEO',
    repo: 'SEO',
    department: 'seo',
    requiresApprovalFor: ['external.publish'],
  },
  {
    id: 'funnel',
    displayName: 'Funnel',
    repo: 'Funnel',
    department: 'funnel',
    requiresApprovalFor: ['external.publish', 'network.write'],
  },
] as const;

/**
 * Hard exclusions. These repositories are never child agents, never routed,
 * never rendered, never a fallback — even if a manifest declares them.
 */
export const EXCLUDED_REPOSITORIES: readonly string[] = [
  'Website-Building',
  'Loop-Engeneering',
  'Prompt-Optimizer',
  'more-available-tokens',
] as const;

/** Repositories that are part of the system but are not child agents. */
export const SYSTEM_REPOSITORIES: readonly string[] = ['HWD-ZERO', 'brain-interface'] as const;

/** Department accent colours. The node bodies stay black; only rims glow. */
export const DEPARTMENT_COLORS: Record<Department, string> = {
  orchestration: 'rgba(186, 148, 255, 1)',
  acquisition: 'rgba(110, 208, 255, 1)',
  social: 'rgba(255, 122, 196, 1)',
  reputation: 'rgba(255, 140, 168, 1)',
  infrastructure: 'rgba(112, 228, 190, 1)',
  outreach: 'rgba(255, 178, 106, 1)',
  seo: 'rgba(96, 214, 226, 1)',
  funnel: 'rgba(226, 120, 255, 1)',
};

const normalize = (value: string): string => value.trim().toLowerCase();

const EXCLUDED = new Set(EXCLUDED_REPOSITORIES.map(normalize));
const SYSTEM = new Set(SYSTEM_REPOSITORIES.map(normalize));
const BY_REPO = new Map(CHILD_AGENTS.map((agent) => [normalize(agent.repo), agent]));
const BY_ID = new Map(CHILD_AGENTS.map((agent) => [normalize(agent.id), agent]));

/** True for the four repositories that must never enter the system. */
export function isExcludedRepository(name: string): boolean {
  return EXCLUDED.has(normalize(name));
}

/** True for ZERO itself and the interface — part of the system, not agents. */
export function isSystemRepository(name: string): boolean {
  return SYSTEM.has(normalize(name));
}

/** The child-agent definition for a repository directory, if it is one. */
export function childAgentForRepo(name: string): ChildAgentDefinition | undefined {
  if (isExcludedRepository(name)) return undefined;
  return BY_REPO.get(normalize(name));
}

/** The child-agent definition for an id (used by manifest entries). */
export function childAgentForId(id: string): ChildAgentDefinition | undefined {
  return BY_ID.get(normalize(id));
}

export function departmentColor(department: Department | undefined): string | undefined {
  return department ? DEPARTMENT_COLORS[department] : undefined;
}
