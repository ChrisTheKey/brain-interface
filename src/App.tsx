import { useCallback, useMemo, useState } from 'react';
import { BrainStage } from './ui/BrainStage';
import { DetailPanel } from './ui/DetailPanel';
import { NodeTooltip } from './ui/NodeTooltip';
import { StatusBar } from './ui/StatusBar';
import { VoiceBar } from './ui/VoiceBar';
import { useZeroBrain } from './state/useZeroBrain';
import { useZeroVoiceLoop } from './state/useZeroVoiceLoop';
import { config } from './config';
import type { GraphNode } from './graph/model';
import type { ZeroAgent } from './zero/agentRegistry';

export default function App(): React.JSX.Element {
  const brain = useZeroBrain();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    node: GraphNode | null;
    position: { x: number; y: number } | null;
  }>({ node: null, position: null });

  const agents = useMemo<ZeroAgent[]>(() => brain.snapshot?.agents ?? [], [brain.snapshot]);

  const handleAgentActivity = useCallback(
    (agentId: string, phase: 'start' | 'finish') => {
      // Real activity, real pulse: the ZERO → agent edge lights up exactly
      // while that agent's thread is running.
      brain.pulsesRef.current.set(`agent:${agentId}`, {
        energy: phase === 'start' ? 1 : 0.4,
        at: Date.now(),
      });
      brain.pulsesRef.current.set('zero', { energy: 0.8, at: Date.now() });
    },
    [brain.pulsesRef],
  );

  const voice = useZeroVoiceLoop({
    client: brain.client,
    agents,
    speak: brain.speak,
    stopSpeaking: brain.stopSpeaking,
    onAgentActivity: handleAgentActivity,
  });

  const selectedNode = useMemo(
    () => brain.graph.nodes.find((node) => node.id === selectedId) ?? null,
    [brain.graph, selectedId],
  );

  const selectedAgent = useMemo<ZeroAgent | null>(() => {
    if (!selectedNode || selectedNode.type !== 'agent') return null;
    const agentId = selectedNode.metadata['agentId'];
    if (typeof agentId !== 'string') return null;
    return agents.find((agent) => agent.id === agentId) ?? null;
  }, [agents, selectedNode]);

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
        conversation={voice.state}
        micLevel={voice.micLevel}
        selectedId={selectedId}
        onSelect={handleSelect}
        onHover={handleHover}
      />
      <NodeTooltip node={hovered.node} position={hovered.position} />
      <DetailPanel
        node={selectedNode}
        graph={brain.graph}
        activity={brain.activity}
        agent={selectedAgent}
        agentBusy={voice.state === 'agentActive' || voice.state === 'processing'}
        onRunAgent={voice.runAgent}
        onClose={() => setSelectedId(null)}
        onSelect={(id) => setSelectedId(id)}
        onSpeak={(text) => void brain.speak(text)}
      />
      <VoiceBar
        state={voice.state}
        listening={voice.listening}
        speechSupported={voice.speechSupported}
        transcript={voice.transcript}
        answer={voice.answer}
        error={voice.error}
        activeAgents={voice.activeAgentIds}
        onToggleListening={voice.startListening}
        onSubmitText={voice.submitText}
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
          else void brain.speak(brain.lastAgentMessage ?? 'ZERO online.');
        }}
        onRefresh={brain.refresh}
      />
    </div>
  );
}
