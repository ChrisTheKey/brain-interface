import type { GraphNode } from '../graph/model';

export interface NodeTooltipProps {
  node: GraphNode | null;
  position: { x: number; y: number } | null;
}

const TYPE_LABEL: Record<GraphNode['type'], string> = {
  zero: 'Orchestrator',
  agent: 'Agent',
  session: 'Session (ZERO thread)',
  subAgent: 'Sub-agent',
  skill: 'Knowledge (skill)',
  mcpServer: 'Tool provider (MCP server)',
  tool: 'Tool',
  resource: 'Source (MCP resource)',
  app: 'Connector (app)',
  toolDependency: 'Declared tool dependency',
};

export function NodeTooltip({ node, position }: NodeTooltipProps): React.JSX.Element | null {
  if (!node || !position) return null;
  return (
    <div
      className="tooltip"
      style={{ left: `${position.x + 16}px`, top: `${position.y + 16}px` }}
      role="tooltip"
    >
      <div className="tooltip-title">{node.label}</div>
      <div className="tooltip-type">{TYPE_LABEL[node.type]}</div>
      <div className={`tooltip-status status-${node.status}`}>{node.status}</div>
      {node.description ? <p className="tooltip-description">{node.description}</p> : null}
    </div>
  );
}
