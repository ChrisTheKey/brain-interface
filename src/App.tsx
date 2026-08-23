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
import { useVoiceTurn, visualStateForWake } from './state/useVoiceTurn';
import { useWakeWord } from './state/useWakeWord';
import { useTtsStatus } from './state/useTtsStatus';
import { useWebStatus } from './state/useWebStatus';
import { zeroNodeDescription, zeroNodeLabel, zeroNodeStatus } from './zero/connectionState';
import { HwdZeroClient } from './hwd/client';
import { config } from './config';
import type { GraphNode } from './graph/model';
import type { ZeroAgent } from './zero/agentRegistry';
import { withZeroStatus, type GraphRuntime } from './graph/transform';
import { socialBranch, withSocial } from './graph/social';
import { adsBranch, withAds } from './graph/ads';
import { useMetricool } from './state/useMetricool';
import { useMetaAds } from './state/useMetaAds';
import { MetricoolPanel } from './ui/MetricoolPanel';
import { MetaAdsPanel } from './ui/MetaAdsPanel';

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
  // Whether ZERO can publish, and to what. Read from the runtime, refreshed on
  // the events that change it — never polled on a timer.
  const metricool = useMetricool(operatorClient, operator.events);
  // Whether ZERO can read the ad account, and — separately — whether it could
  // change it. Meta rolls this out per account, so both are read, not assumed.
  const metaAds = useMetaAds(operatorClient, operator.events);

  const graph = useMemo(() => {
    const base = withZeroStatus(brain.graph, zeroNodeStatus(status.state), {
      label: zeroNodeLabel(status.runtime, status.state),
      description: zeroNodeDescription(status.runtime),
    });
    // The publishing branch is drawn from real connections and real events:
    // there is no node for a network the brand is not connected to, and
    // PUBLISHING only ever appears after the runtime said it was publishing,
    // which it does not say before a human has approved.
    const published = withSocial(base, socialBranch(metricool.status, operator.events));
    // The advertising branch, drawn the same way and from the same kind of
    // evidence: one node per ad account this login really reaches, and no
    // UPDATING state until the runtime says it is updating — which it does not
    // say before a human approves.
    return withAds(published, adsBranch(metaAds.status, operator.events));
  }, [
    brain.graph,
    status.state,
    status.runtime,
    metricool.status,
    metaAds.status,
    operator.events,
  ]);

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

  // Hands-free. An activation layer in front of the same turn above — not a
  // second pipeline, and off until the operator switches it on.
  const wake = useWakeWord({
    deliver: voice.submitVoice,
    speaking: voice.state === 'speaking',
    language: config.speech.language,
  });

  const tts = useTtsStatus();
  const web = useWebStatus();

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
        conversation={visualStateForWake(wake.enabled ? wake.state : 'off', voice.state)}
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
        wake={wake.enabled ? wake.diagnostics : null}
        tts={tts}
        web={web}
        onRetry={() => {
          status.retry();
          childAgents.refresh();
          brain.refresh();
          void operator.refresh();
        }}
        showDiagnostics={showDiagnostics}
      />
      <OperatorPanel operator={operator} />

      <MetricoolPanel metricool={metricool} />

      <MetaAdsPanel ads={metaAds} />
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
      <VoiceBar voice={voice} wake={wake} onInterrupt={voice.interrupt} />
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
