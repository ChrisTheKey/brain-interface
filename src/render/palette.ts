import type { NodeStatus, NodeType } from '../graph/model';

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
    coreInner: '#0a0c12',
    coreOuter: '#000000',
    rim: 'rgba(226, 232, 246, 0.5)',
    rimActive: 'rgba(255, 255, 255, 0.88)',
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
  toolDependency: {
    coreInner: '#070709',
    coreOuter: '#000000',
    rim: 'rgba(198, 198, 206, 0.3)',
    rimActive: 'rgba(240, 240, 246, 0.75)',
  },
};

/** Status is a small accent arc, not a fill — it must stay quiet. */
export const STATUS_ACCENT: Record<NodeStatus, string> = {
  active: 'rgba(255, 132, 205, 0.95)',
  idle: 'rgba(230, 232, 242, 0.42)',
  error: 'rgba(255, 118, 118, 0.9)',
  notLoaded: 'rgba(190, 196, 212, 0.22)',
  disabled: 'rgba(160, 160, 172, 0.18)',
  unknown: 'rgba(190, 190, 200, 0.26)',
};
