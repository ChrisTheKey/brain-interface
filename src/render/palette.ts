import type { GraphNode, NodeStatus, NodeType } from '../graph/model';
import { DEPARTMENT_COLORS, type Department } from '../zero/agentPolicy';

export interface NodePalette {
  /** Inner colour of the disc — every node is black; only the sheen differs. */
  coreInner: string;
  coreOuter: string;
  /** Thin rim that carries the (restrained) type identity. */
  rim: string;
  /** Rim colour while hovered or selected. */
  rimActive: string;
}

/**
 * The brain is black on the background image. Node identity is carried by a
 * thin rim and by size — never by a filled colour — so the graph stays
 * elegant and readable over a busy backdrop.
 */
export const NODE_PALETTE: Record<NodeType, NodePalette> = {
  zero: {
    coreInner: '#0b0d14',
    coreOuter: '#000000',
    rim: 'rgba(236, 232, 244, 0.55)',
    rimActive: 'rgba(255, 255, 255, 0.9)',
  },
  agent: {
    coreInner: '#0b0d15',
    coreOuter: '#000000',
    rim: 'rgba(238, 240, 252, 0.6)',
    rimActive: 'rgba(255, 255, 255, 0.95)',
  },
  session: {
    coreInner: '#090b10',
    coreOuter: '#000000',
    rim: 'rgba(214, 222, 240, 0.4)',
    rimActive: 'rgba(250, 252, 255, 0.86)',
  },
  subAgent: {
    coreInner: '#080a10',
    coreOuter: '#000000',
    rim: 'rgba(206, 216, 236, 0.42)',
    rimActive: 'rgba(246, 250, 255, 0.85)',
  },
  skill: {
    coreInner: '#0a0810',
    coreOuter: '#000000',
    rim: 'rgba(226, 204, 240, 0.44)',
    rimActive: 'rgba(252, 238, 255, 0.86)',
  },
  mcpServer: {
    coreInner: '#0c0910',
    coreOuter: '#000000',
    rim: 'rgba(244, 214, 232, 0.46)',
    rimActive: 'rgba(255, 240, 250, 0.88)',
  },
  tool: {
    coreInner: '#08070c',
    coreOuter: '#000000',
    rim: 'rgba(230, 210, 224, 0.34)',
    rimActive: 'rgba(255, 244, 252, 0.8)',
  },
  resource: {
    coreInner: '#07080c',
    coreOuter: '#000000',
    rim: 'rgba(212, 224, 232, 0.32)',
    rimActive: 'rgba(244, 252, 255, 0.78)',
  },
  app: {
    coreInner: '#0a080e',
    coreOuter: '#000000',
    rim: 'rgba(238, 212, 234, 0.4)',
    rimActive: 'rgba(255, 240, 252, 0.84)',
  },
  socialHub: {
    // Warmer than the tool providers around it, because this is the one branch
    // of the brain that reaches people rather than machines.
    coreInner: '#0d0b12',
    coreOuter: '#000000',
    rim: 'rgba(246, 226, 232, 0.5)',
    rimActive: 'rgba(255, 246, 250, 0.92)',
  },
  socialNetwork: {
    coreInner: '#0a090d',
    coreOuter: '#000000',
    rim: 'rgba(232, 218, 226, 0.36)',
    rimActive: 'rgba(255, 244, 250, 0.82)',
  },
  adsHub: {
    // The only branch of the brain that spends money. Its rim runs warmer
    // than the publishing hub for the same reason the gate is stricter.
    coreInner: '#120c0c',
    coreOuter: '#000000',
    rim: 'rgba(255, 214, 200, 0.52)',
    rimActive: 'rgba(255, 236, 226, 0.94)',
  },
  adsAccount: {
    coreInner: '#0c0909',
    coreOuter: '#000000',
    rim: 'rgba(240, 214, 206, 0.36)',
    rimActive: 'rgba(255, 238, 230, 0.82)',
  },
  toolDependency: {
    coreInner: '#070709',
    coreOuter: '#000000',
    rim: 'rgba(198, 198, 206, 0.3)',
    rimActive: 'rgba(240, 240, 246, 0.75)',
  },
};

/**
 * A child agent's rim carries its department colour. The body stays black, so
 * the palette reads as eight distinguishable accents on dark tissue rather
 * than as a coloured dashboard.
 */
export function rimColorFor(node: GraphNode, active: boolean): string | undefined {
  const department = node.metadata['department'];
  if (typeof department !== 'string') return undefined;
  const base = DEPARTMENT_COLORS[department as Department];
  if (!base) return undefined;
  return withAlpha(base, active ? 0.95 : 0.62);
}

/** Same colour, dimmer, for the halo around an active agent. */
export function glowColorFor(node: GraphNode, alpha: number): string | undefined {
  const department = node.metadata['department'];
  if (typeof department !== 'string') return undefined;
  const base = DEPARTMENT_COLORS[department as Department];
  return base ? withAlpha(base, alpha) : undefined;
}

function withAlpha(rgba: string, alpha: number): string {
  return rgba.replace(/rgba\(([^)]+),\s*[\d.]+\)/, `rgba($1, ${alpha.toFixed(3)})`);
}

/** Status is a small accent arc, not a fill — it must stay quiet. */
export const STATUS_ACCENT: Record<NodeStatus, string> = {
  active: 'rgba(255, 132, 205, 0.95)',
  idle: 'rgba(230, 232, 242, 0.42)',
  error: 'rgba(255, 118, 118, 0.9)',
  notLoaded: 'rgba(190, 196, 212, 0.22)',
  disabled: 'rgba(160, 160, 172, 0.18)',
  unknown: 'rgba(190, 190, 200, 0.26)',
};
