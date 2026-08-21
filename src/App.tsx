import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrainStage } from './ui/BrainStage';
import { DetailPanel } from './ui/DetailPanel';
import { NodeTooltip } from './ui/NodeTooltip';
import { OperatorPanel } from './ui/OperatorPanel';
import { StatusBar } from './ui/StatusBar';
import { VoiceBar } from './ui/VoiceBar';
import { ZeroPanel } from './ui/ZeroPanel';
import { useZeroBrain } from './state/useZeroBrain';
import { useOperator } from './state/useOperator';
import { useZeroStatus } from './state/useZeroStatus';
import { useChildAgents } from './state/useChildAgents';
import { useVoiceTurn, visualStateFor } from './state/useVoiceTurn';
import { zeroNodeDescription, zeroNodeLabel, zeroNodeStatus } from './zero/connectionState';
import { HwdZeroClient } from './hwd/client';
import { config } from './config';
import type { GraphNode } from './graph/model';
import type { ZeroAgent } from './zero/agentRegistry';
import { withZeroStatus, type GraphRuntime } from './graph/transform';

export default function App(): React.JSX.Element {
  // Same origin: the gateway on port 3000 proxies /api and /ws to HWD-ZERO on
  // loopback, so the operator needs no address and no credential here.
  const [operatorClient] = useState(() => new HwdZeroClient());
  const operator = useOperator(operatorClient);

  // Runtime facts about agent runs feed back into the graph, so an agent node
  // is `active` exactly while its ZERO thread runs.
  const [runtime, setRuntime] = useState<GraphRuntime>({});
  const agentTasksRef = useRef<Map<string, { task: string; status: string; at: number }>>(new Map());
  const brain = useZeroBrain(runtime);

  // The single source of truth for what the interface may claim about ZERO.
  // READY needs HTTP health *and* an open same-origin socket *and* a real
  // answer from the backend — a rendered bundle proves none of the three.
  const status = useZeroStatus({
    // The canonical runtime is HWD-ZERO's ZeroSession, reached over
    // /ws/events. `brain.connection` is the optional codex executor's socket
    // and never gates anything.
    codexSocket: brain.connection,
    eventStream: operator.connection,
    runtimeAnnounced: operator.runtimeAnnounced,
    runtimeResponded: brain.runtimeResponded,
    operatorResponded: operator.responded,
    safeMode: operator.safeMode,
    error: brain.connectionError ?? operator.error,
  });

  // Child agents come from the runtime once it is healthy — never from the
  // brain's role registry, which is a different population entirely.
  const childAgents = useChildAgents(operatorClient, status.health?.zero === 'healthy');

  const showDiagnostics = import.meta.env.DEV;

  // The ZERO node shows the *connection*, not "did a snapshot arrive". Offline
  // must look offline instead of looking like an empty graph.
  const graph = useMemo(
    () =>
      withZeroStatus(brain.graph, zeroNodeStatus(status.state), {
        label: zeroNodeLabel(status.runtime, status.state),
        description: zeroNodeDescription(status.runtime),
      }),
    [brain.graph, status.state, status.runtime],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    node: GraphNode | null;
    position: { x: number; y: number } | null;
  }>({ node: null, position: null });

  const agents = useMemo<ZeroAgent[]>(() => brain.snapshot?.agents ?? [], [brain.snapshot]);

  // Agent activity in the graph comes from the operator's real event stream:
  // `agent.started` / `agent.completed` are facts HWD-ZERO published, not
  // something the interface inferred from its own routing. Previously these
  // pulses came from the codex loop, so with codex offline the graph never
  // moved even while missions ran.
  const latestEvent = operator.events.at(-1);
  useEffect(() => {
    if (!latestEvent) return;
    const agentId = latestEvent.agent_id;
    if (!agentId || agentId === 'zero') return;
    const started =
      latestEvent.type === 'agent.started' || latestEvent.type === 'agent.activity';
    const finished =
      latestEvent.type === 'agent.completed' || latestEvent.type === 'agent.error';
    if (!started && !finished) return;

    // Real activity, real pulse: the ZERO → agent edge lights up exactly while
    // that agent is running.
    const now = Date.now();
    brain.pulsesRef.current.set(`agent:${agentId}`, { energy: started ? 1 : 0.4, at: now });
    brain.pulsesRef.current.set('zero', { energy: 0.8, at: now });

    const tasks = agentTasksRef.current;
    const previous = tasks.get(agentId);
    tasks.set(agentId, {
      task: String(latestEvent.payload['task'] ?? previous?.task ?? ''),
      status: started ? 'running' : latestEvent.type === 'agent.error' ? 'error' : 'completed',
      at: now,
    });
    setRuntime((current) => ({
      activeAgentIds: started
        ? [...new Set([...(current.activeAgentIds ?? []), agentId])]
        : (current.activeAgentIds ?? []).filter((id) => id !== agentId),
      agentTasks: new Map(tasks),
    }));
  }, [latestEvent, brain.pulsesRef]);


  // The spoken turn. It talks to HWD-ZERO — the runtime — rather than to the
  // optional codex client the old loop routed through, which is why speaking
  // did nothing while CODEX EXECUTOR was offline.
  const voice = useVoiceTurn({
    language: config.speech.language,
    speak: brain.speak,
    stopSpeaking: brain.stopSpeaking,
  });

  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph, selectedId],
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
        graph={graph}
        pulsesRef={brain.pulsesRef}
        levels={brain.levels}
        conversation={visualStateFor(voice.state)}
        micLevel={voice.micLevel}
        selectedId={selectedId}
        onSelect={handleSelect}
        onHover={handleHover}
      />
      <ZeroPanel
        status={status}
        childAgents={
          childAgents.loaded
            ? {
                discovered: childAgents.discovered,
                allowed: childAgents.allowed,
                missing: childAgents.missing,
              }
            : null
        }
        voiceState={brain.voiceState}
        onRetry={() => {
          status.retry();
          childAgents.refresh();
          brain.refresh();
          void operator.refresh();
        }}
        showDiagnostics={showDiagnostics}
      />
      <OperatorPanel operator={operator} />
      <NodeTooltip node={hovered.node} position={hovered.position} />
      <DetailPanel
        node={selectedNode}
        graph={graph}
        activity={brain.activity}
        agent={selectedAgent}
        agentBusy={voice.state === 'executing' || voice.state === 'understanding'}
        onClose={() => setSelectedId(null)}
        onSelect={(id) => setSelectedId(id)}
        onSpeak={(text) => void brain.speak(text)}
      />
      <VoiceBar voice={voice} onInterrupt={voice.interrupt} />
      <StatusBar
        status={status}
        connectionError={brain.connectionError}
        showDiagnostics={showDiagnostics}
        snapshot={brain.snapshot}
        graph={graph}
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
