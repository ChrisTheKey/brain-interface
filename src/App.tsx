import { useCallback, useMemo, useRef, useState } from 'react';
import { BrainStage } from './ui/BrainStage';
import { DetailPanel } from './ui/DetailPanel';
import { NodeTooltip } from './ui/NodeTooltip';
import { OperatorPanel } from './ui/OperatorPanel';
import { StatusBar } from './ui/StatusBar';
import { VoiceBar } from './ui/VoiceBar';
import { VoiceMode } from './ui/VoiceMode';
import { IntegrationsPanel } from './ui/IntegrationsPanel';
import { useZeroBrain } from './state/useZeroBrain';
import { useZeroVoiceLoop } from './state/useZeroVoiceLoop';
import { useIntegrations } from './state/useIntegrations';
import { useBrowserBridge } from './state/useBrowserBridge';
import { useOperator } from './state/useOperator';
import { useRoute } from './state/useRoute';
import { HwdZeroClient } from './hwd/client';
import { config } from './config';
import type { GraphNode } from './graph/model';
import type { ZeroAgent } from './zero/agentRegistry';
import type { GraphRuntime } from './graph/transform';

export default function App(): React.JSX.Element {
  // Same origin: the gateway on port 3000 proxies /api and /ws to HWD-ZERO on
  // loopback, so the operator needs no address and no credential here.
  const [operatorClient] = useState(() => new HwdZeroClient());
  const operator = useOperator(operatorClient);
  const { route, navigate } = useRoute();

  // Runtime facts about agent runs feed back into the graph, so an agent node
  // is `active` exactly while its ZERO thread runs.
  const [runtime, setRuntime] = useState<GraphRuntime>({});
  const agentTasksRef = useRef<Map<string, { task: string; status: string; at: number }>>(new Map());
  const brain = useZeroBrain(runtime);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    node: GraphNode | null;
    position: { x: number; y: number } | null;
  }>({ node: null, position: null });

  const agents = useMemo<ZeroAgent[]>(() => brain.snapshot?.agents ?? [], [brain.snapshot]);

  const handleAgentActivity = useCallback(
    (
      agentId: string,
      phase: 'start' | 'finish',
      detail?: { task?: string; result?: { status: string } },
    ) => {
      // Real activity, real pulse: the ZERO → agent edge lights up exactly
      // while that agent's thread is running.
      const now = Date.now();
      brain.pulsesRef.current.set(`agent:${agentId}`, {
        energy: phase === 'start' ? 1 : 0.4,
        at: now,
      });
      brain.pulsesRef.current.set('zero', { energy: 0.8, at: now });

      const tasks = agentTasksRef.current;
      const previous = tasks.get(agentId);
      tasks.set(agentId, {
        task: detail?.task ?? previous?.task ?? '',
        status: phase === 'start' ? 'running' : (detail?.result?.status ?? 'completed'),
        at: now,
      });
      setRuntime((current) => ({
        activeAgentIds:
          phase === 'start'
            ? [...new Set([...(current.activeAgentIds ?? []), agentId])]
            : (current.activeAgentIds ?? []).filter((id) => id !== agentId),
        agentTasks: new Map(tasks),
      }));
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

  // ZERO's internet access: the gateway reports which browsers exist here and
  // which one is running, and it is the only place that knows where this
  // interface is installed — which the browser MCP entry needs.
  const browserBridge = useBrowserBridge();
  const integrations = useIntegrations(brain.client, browserBridge.features);

  // Voice mode is opened by a click, which is the gesture the AudioContext
  // needs anyway — so ZERO can answer out loud from the first turn.
  const startVoiceMode = useCallback(() => {
    navigate('voice');
    if (config.voiceMode.autoStart) voice.startConversation();
  }, [navigate, voice]);

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

  if (route === 'voice') {
    return (
      <div className="app app-voice">
        <div
          className="background"
          style={{ backgroundImage: `url(${config.backgroundImage})` }}
          aria-hidden="true"
        />
        <VoiceMode
          state={voice.state}
          listening={voice.listening}
          conversationActive={voice.conversationActive}
          speechSupported={voice.speechSupported}
          transcript={voice.transcript}
          answer={voice.answer}
          error={voice.error ?? brain.connectionError}
          activeAgents={voice.activeAgentIds}
          voiceProviderId={brain.voiceProviderId}
          voiceReason={brain.voiceReason}
          connection={brain.connection}
          micLevel={voice.micLevel}
          levels={brain.levels}
          onToggleConversation={voice.toggleConversation}
          onPushToTalk={voice.startListening}
          onSubmitText={voice.submitText}
          onExit={() => {
            voice.stopConversation();
            navigate('brain');
          }}
        />
      </div>
    );
  }

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
      <OperatorPanel operator={operator} />
      <IntegrationsPanel integrations={integrations} browser={browserBridge} />
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
        onEnterVoiceMode={startVoiceMode}
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
