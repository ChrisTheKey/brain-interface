/**
 * The ZERO Brain Interface.
 *
 *   USER
 *    ↓
 *   brain-interface :3000              this app, served by the gateway
 *    ↓
 *   /api  ·  /ws/events  ·  /ws/voice  the only ways out of the browser
 *    ↓
 *   HWD-ZERO                           the operator: the one runtime
 *    ↓
 *   ZeroSession → Agents · Memory · Missions · Permissions
 *
 * This app renders and asks. It holds no credentials, starts no process,
 * touches no shell and routes nothing: every action is a request to HWD-ZERO,
 * which is free to refuse it. What HWD-ZERO does not provide is degraded
 * visibly and named in the system bar rather than filled in.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { config } from './config';
import { HwdZeroClient } from './hwd/client';
import { useOperator } from './state/useOperator';
import { useVoiceSession } from './state/useVoiceSession';
import { buildBrain } from './brain/build';
import type { BrainNode } from './brain/model';
import { deriveRuntimeState } from './runtime/states';
import { BrainSignals } from './three/signals';
import type { QualityProfile } from './three/quality';
import { AgentDetail } from './ui/AgentDetail';
import { ApprovalGate } from './ui/ApprovalGate';
import { MissionStrip } from './ui/MissionStrip';
import { NodeTooltip } from './ui/NodeTooltip';
import { StateRing } from './ui/StateRing';
import { SystemBar } from './ui/SystemBar';
import { VoiceBar } from './ui/VoiceBar';

/**
 * The WebGL layer is the heavy half of the bundle and none of the HUD needs
 * it, so it streams in behind the fallback plate: on a phone the operator's
 * state, the gates and the microphone are usable before three.js has landed.
 */
const BrainCanvas = lazy(() =>
  import('./three/BrainCanvas').then((module) => ({ default: module.BrainCanvas })),
);

/** Events that light an agent's path outward or bring energy back to ZERO. */
const OUTWARD_EVENTS = new Set(['agent.started', 'agent.activity']);
const INWARD_EVENTS = new Set(['agent.completed', 'agent.error']);

export default function App(): React.JSX.Element {
  // Same origin: the gateway on port 3000 proxies /api and /ws to HWD-ZERO on
  // loopback, so there is no address and no credential in this bundle.
  const [client] = useState(
    () =>
      new HwdZeroClient({
        ...(config.apiBaseUrl ? { baseUrl: config.apiBaseUrl } : {}),
        reconnectDelayMs: config.reconnectDelayMs,
      }),
  );
  const operator = useOperator(client, { pollIntervalMs: config.refreshIntervalMs });
  const voice = useVoiceSession({ client });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<{
    node: BrainNode | null;
    position: { x: number; y: number } | null;
  }>({ node: null, position: null });
  const [quality, setQuality] = useState<QualityProfile | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const graph = useMemo(
    () => buildBrain(operator.registry, operator.agentRuntime),
    [operator.registry, operator.agentRuntime],
  );

  /* ----------------------------- runtime state --------------------------- */

  const runtimeState = useMemo(
    () =>
      deriveRuntimeState({
        connection: operator.connection,
        safeMode: operator.safeMode,
        approvalsPending: operator.approvals.length,
        micOpen: voice.listening,
        finalizing: voice.finalizing,
        awaitingResponse: voice.awaitingResponse,
        speaking: voice.speaking,
        missionPhase: operator.missionPhase,
        error: voice.error ?? (operator.error || null),
        reported: voice.reportedState ?? operator.reportedState,
      }),
    [
      operator.connection,
      operator.safeMode,
      operator.approvals.length,
      operator.missionPhase,
      operator.error,
      operator.reportedState,
      voice.listening,
      voice.finalizing,
      voice.awaitingResponse,
      voice.speaking,
      voice.error,
      voice.reportedState,
    ],
  );

  /* --------------------------- the render bridge ------------------------- */

  const signalsRef = useRef<BrainSignals>(new BrainSignals());

  useEffect(() => {
    signalsRef.current.state = runtimeState;
  }, [runtimeState]);

  useEffect(() => {
    signalsRef.current.estimated = voice.estimated;
  }, [voice.estimated]);

  // Real events, real energy: a task going out pushes energy from ZERO to the
  // agent, a result coming back pulls it in. Nothing here is on a timer.
  const seenEvents = useRef<Set<string>>(new Set());
  useEffect(() => {
    const signals = signalsRef.current;
    for (const event of operator.events) {
      if (seenEvents.current.has(event.event_id)) continue;
      seenEvents.current.add(event.event_id);
      if (!event.agent_id) continue;
      if (OUTWARD_EVENTS.has(event.type)) signals.pulse(event.agent_id, 1, 1);
      else if (INWARD_EVENTS.has(event.type)) signals.pulse(event.agent_id, -1, 1);
    }
    // The stream is capped, so the seen-set is capped with it.
    if (seenEvents.current.size > 1_000) {
      seenEvents.current = new Set(operator.events.map((event) => event.event_id));
    }
  }, [operator.events]);

  /* ------------------------------- speaking ------------------------------ */

  const lastSpoken = useRef('');
  useEffect(() => {
    if (!config.voice.autoSpeak) return;
    const text = voice.response.trim();
    if (text.length === 0 || text === lastSpoken.current) return;
    lastSpoken.current = text;
    // On the streaming tier HWD-ZERO voices its own answer on the same
    // channel; asking for it again would speak it twice.
    if (voice.tier === 'stream') return;
    voice.speak(text);
  }, [voice]);

  /* ------------------------------ interaction ---------------------------- */

  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );

  const selectedCluster = useMemo(() => {
    if (!selectedNode?.clusterId) return null;
    return graph.clusters.find((cluster) => cluster.agentId === selectedNode.clusterId) ?? null;
  }, [graph.clusters, selectedNode]);

  const handleSelect = useCallback((node: BrainNode | null) => {
    setSelectedId(node?.id ?? null);
    setPanelOpen(node !== null);
  }, []);

  const handleHover = useCallback(
    (node: BrainNode | null, position: { x: number; y: number } | null) => {
      setHovered({ node, position });
    },
    [],
  );

  /* ----------------------------- degradations ---------------------------- */

  const degradations = useMemo(() => {
    const list: string[] = [];
    if (voice.channelStatus === 'unavailable') {
      list.push(
        'Missing contract: WS /ws/voice. The final transcript is handed over as POST /api/missions instead, and ZERO’s answer arrives on /ws/events.',
      );
    }
    if (voice.tierNote) list.push(`Voice: ${voice.tierNote}`);
    if (voice.audioUnavailable) list.push(`Audio: ${voice.audioUnavailable}`);
    if (operator.gateway && !operator.gateway.upstream.reachable) {
      list.push(
        `HWD-ZERO is not reachable at ${operator.gateway.zeroApi}${
          operator.gateway.upstream.error ? ` (${operator.gateway.upstream.error})` : ''
        }. The gateway is up; the operator is not.`,
      );
    }
    if (!voice.speechSupported) {
      list.push('This browser has no SpeechRecognition engine — spoken input is unavailable.');
    }
    return list;
  }, [voice, operator.gateway]);

  const activeAgents = operator.agentRuntime.activeAgentIds;

  return (
    <div className={`app state-${runtimeState.toLowerCase()}`}>
      {/* Fallback plate: visible before the WebGL texture decodes, and the
          whole background if this device has no WebGL at all. */}
      <div
        className="background"
        style={{ backgroundImage: `url(${config.backgroundImage})` }}
        aria-hidden="true"
      />

      <Suspense fallback={null}>
        <BrainCanvas
          graph={graph}
          signals={signalsRef}
          sampleLevels={voice.levels}
          sampleMic={voice.micLevel}
          selectedId={selectedId}
          onSelect={handleSelect}
          onHover={handleHover}
          onQualityChange={setQuality}
        />
      </Suspense>

      <header className="hud-top">
        <StateRing
          state={runtimeState}
          detail={
            runtimeState === 'AWAITING_APPROVAL'
              ? `${operator.approvals.length} gate${operator.approvals.length === 1 ? '' : 's'}`
              : runtimeState === 'ERROR'
                ? (voice.error ?? operator.error)
                : null
          }
        />
        <div className="hud-operator">
          <MissionStrip
            missions={operator.missions}
            offline={operator.connection === 'unreachable' && !operator.state}
            offlineReason={operator.error}
          />
        </div>
      </header>

      <NodeTooltip node={hovered.node} position={hovered.position} />

      {panelOpen ? (
        <AgentDetail
          node={selectedNode}
          cluster={selectedCluster}
          notes={graph.notes}
          excluded={graph.excluded}
          onClose={() => {
            setPanelOpen(false);
            setSelectedId(null);
          }}
        />
      ) : null}

      <footer className="hud-bottom">
        {/*
          The gate sits directly above the microphone, not at the far corner of
          the screen: it is the one thing that stops the system, and on a phone
          it has to be answerable with the thumb that is already there.
        */}
        <ApprovalGate
          approvals={operator.approvals}
          safeMode={operator.safeMode}
          onApprove={(approval) => void operator.approve(approval)}
        />
        <VoiceBar
          state={runtimeState}
          listening={voice.listening}
          speechSupported={voice.speechSupported}
          partial={voice.partial}
          finalTranscript={voice.finalTranscript}
          response={voice.response}
          error={voice.error}
          tier={voice.tier}
          tierNote={voice.tierNote}
          estimated={voice.estimated}
          activeAgents={activeAgents}
          onToggleListening={voice.listening ? voice.stopListening : voice.startListening}
          onSubmitText={voice.submitText}
          onReplay={() => voice.speak(voice.response)}
        />
        <SystemBar
          connection={operator.connection}
          error={operator.error}
          state={operator.state}
          gateway={operator.gateway}
          channelStatus={voice.channelStatus}
          quality={quality}
          agents={graph.clusters.length}
          notes={graph.notes}
          degradations={degradations}
          safeMode={operator.safeMode}
          onToggleSafeMode={() => void operator.setSafeMode(!operator.safeMode)}
          onRefresh={() => void operator.refresh()}
        />
      </footer>
    </div>
  );
}
