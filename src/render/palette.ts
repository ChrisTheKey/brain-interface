import type { NodeStatus, NodeType } from '../graph/model';

export interface NodePalette {
  core: string;
  halo: string;
  ring: string;
}

/** Colour is carried by node type; status only modulates the ring. */
export const NODE_PALETTE: Record<NodeType, NodePalette> = {
  zero: { core: '#05070d', halo: 'rgba(120,160,255,0.55)', ring: 'rgba(190,214,255,0.85)' },
  agent: { core: '#101a2f', halo: 'rgba(122,178,255,0.35)', ring: 'rgba(150,196,255,0.9)' },
  subAgent: { core: '#111d24', halo: 'rgba(110,214,220,0.32)', ring: 'rgba(140,226,232,0.85)' },
  skill: { core: '#1a1630', halo: 'rgba(178,140,255,0.32)', ring: 'rgba(198,168,255,0.85)' },
  mcpServer: { core: '#221a12', halo: 'rgba(255,190,120,0.32)', ring: 'rgba(255,206,150,0.85)' },
  tool: { core: '#1d1a14', halo: 'rgba(240,200,140,0.25)', ring: 'rgba(238,206,158,0.7)' },
  resource: { core: '#141d1a', halo: 'rgba(150,230,190,0.25)', ring: 'rgba(168,236,200,0.7)' },
  app: { core: '#1c1420', halo: 'rgba(255,150,210,0.3)', ring: 'rgba(255,178,222,0.8)' },
  toolDependency: { core: '#181818', halo: 'rgba(180,180,180,0.22)', ring: 'rgba(200,200,200,0.6)' },
};

export const STATUS_ACCENT: Record<NodeStatus, string> = {
  active: 'rgba(126,224,255,0.95)',
  idle: 'rgba(190,206,236,0.55)',
  error: 'rgba(255,120,120,0.9)',
  notLoaded: 'rgba(150,160,185,0.3)',
  disabled: 'rgba(130,130,140,0.25)',
  unknown: 'rgba(160,160,170,0.35)',
};
