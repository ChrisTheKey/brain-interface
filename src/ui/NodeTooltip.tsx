import type { BrainNode } from '../brain/model';

export interface NodeTooltipProps {
  node: BrainNode | null;
  position: { x: number; y: number } | null;
}

const KIND_LABEL: Record<BrainNode['kind'], string> = {
  core: 'HWD-ZERO — the operator',
  agent: 'Child agent',
  satellite: 'Capability',
};

export function NodeTooltip({ node, position }: NodeTooltipProps): React.JSX.Element | null {
  if (!node || !position) return null;
  // A structural terminal is a node the operator reported no detail for;
  // saying so is better than showing an empty tooltip.
  const structural = node.metadata['terminal'] === 'structural';
  return (
    <div
      className="tooltip"
      style={{ left: `${position.x + 16}px`, top: `${position.y + 16}px` }}
      role="tooltip"
    >
      <div className="tooltip-title">{node.label || (structural ? 'terminal' : node.id)}</div>
      <div className="tooltip-type">{KIND_LABEL[node.kind]}</div>
      <div className={`tooltip-status status-${node.status}`}>{node.status}</div>
      {structural ? (
        <p className="tooltip-description dim">HWD-ZERO reported no detail for this terminal.</p>
      ) : null}
      {node.description ? <p className="tooltip-description">{node.description}</p> : null}
    </div>
  );
}
