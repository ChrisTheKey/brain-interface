import { useCallback, useMemo, useState } from 'react';
import { BrainStage } from './ui/BrainStage';
import { DetailPanel } from './ui/DetailPanel';
import { NodeTooltip } from './ui/NodeTooltip';
import { StatusBar } from './ui/StatusBar';
import { useZeroBrain } from './state/useZeroBrain';
import { config } from './config';
import type { GraphNode } from './graph/model';

export default function App(): React.JSX.Element {
  const brain = useZeroBrain();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    node: GraphNode | null;
    position: { x: number; y: number } | null;
  }>({ node: null, position: null });

  const selectedNode = useMemo(
    () => brain.graph.nodes.find((node) => node.id === selectedId) ?? null,
    [brain.graph, selectedId],
  );

  const handleHover = useCallback(
    (node: GraphNode | null, position: { x: number; y: number } | null) => {
      setHovered({ node, position });
    },
    [],
  );

  const handleSelect = useCallback((node: GraphNode | null) => {
    setSelectedId(node?.id ?? null);
  }, []);

  return (
    <div className="app">
      <div
        className="background"
        style={{ backgroundImage: `url(${config.backgroundImage})` }}
        aria-hidden="true"
      />
      <BrainStage
        graph={brain.graph}
        pulsesRef={brain.pulsesRef}
        levels={brain.levels}
        selectedId={selectedId}
        onSelect={handleSelect}
        onHover={handleHover}
      />
      <NodeTooltip node={hovered.node} position={hovered.position} />
      <DetailPanel
        node={selectedNode}
        graph={brain.graph}
        activity={brain.activity}
        onClose={() => setSelectedId(null)}
        onSelect={(id) => setSelectedId(id)}
        onSpeak={brain.speak}
      />
      <StatusBar
        connection={brain.connection}
        connectionError={brain.connectionError}
        zeroUrl={config.zeroWsUrl}
        snapshot={brain.snapshot}
        graph={brain.graph}
        voiceState={brain.voiceState}
        voiceReason={brain.voiceReason}
        onActivateVoice={() => {
          if (brain.voiceState === 'speaking') brain.stopSpeaking();
          else brain.speak(brain.lastAgentMessage ?? 'ZERO online.');
        }}
        onRefresh={brain.refresh}
      />
    </div>
  );
}
