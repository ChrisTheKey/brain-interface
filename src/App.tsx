import { useCallback, useMemo, useRef, useState } from 'react';
import { BrainStage3D } from './ui/BrainStage3D';
import { AgentDetail } from './ui/AgentDetail';
import { OperatorPanel } from './ui/OperatorPanel';
import { StatusBar } from './ui/StatusBar';
import { VoiceBar } from './ui/VoiceBar';
import { useZeroBrain } from './state/useZeroBrain';
import { useZeroVoiceLoop } from './state/useZeroVoiceLoop';
import { useOperator } from './state/useOperator';
import { useAgentActivity } from './state/useAgentActivity';
import { HwdZeroClient } from './hwd/client';
import { config } from './config';
import type { ZeroAgent } from './zero/agentRegistry';
import type { GraphRuntime } from './graph/transform';

export default function App(): React.JSX.Element {
  // Same origin: the gateway on port 3000 proxies /api and /ws to HWD-ZERO on
  // loopback, so the operator needs no address and no credential here.
  const [operatorClient] = useState(() => new HwdZeroClient());
  const operator = useOperator(operatorClient);

  // What the brain draws comes from ZERO's own event stream: an agent glows
  // because the operator said it started, never because the interface guessed.
  const activity = useAgentActivity(operator.events);

  // Runtime facts about agent runs feed back into the graph, so an agent node
  // is `active` exactly while its ZERO thread runs.
  const [runtime, setRuntime] = useState<GraphRuntime>({});
  const agentTasksRef = useRef<Map<string, { task: string; status: string; at: number }>>(new Map());
  const brain = useZeroBrain(runtime);
  /** The child agent the operator has focused in the 3D brain, if any. */
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

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

  // The renderer wants normalised bands; the analyser reports amplitude/peak.
  // Converted here rather than in the render loop so the shape the scene reads
  // is stable regardless of which analyser is behind it.
  const audioBands = useCallback(() => {
    const levels = brain.levels();
    return {
      rms: levels.amplitude,
      low: levels.low,
      mid: (levels.amplitude + levels.high) * 0.5,
      high: levels.high,
      transient: levels.onset,
    };
  }, [brain]);

  return (
    <div className="app">
      <div
        className="background"
        style={{ backgroundImage: `url(${config.backgroundImage})` }}
        aria-hidden="true"
      />
      <BrainStage3D
        agents={operator.agents}
        zeroState={operator.zeroState}
        activityRef={activity.activityRef}
        gatedRef={activity.gatedRef}
        flowRef={activity.flowRef}
        audio={audioBands}
        micLevel={voice.micLevel}
        selectedId={selectedAgentId}
        onSelect={setSelectedAgentId}
      />
      <OperatorPanel operator={operator} />
      <AgentDetail
        agent={operator.agents.find((entry) => entry.id === selectedAgentId) ?? null}
        missions={operator.missions}
        onClose={() => setSelectedAgentId(null)}
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
        operator={operator}
        voiceState={brain.voiceState}
        onToggleVoice={() => {
          if (brain.voiceState === 'speaking') brain.stopSpeaking();
          else void brain.speak('ZERO online.');
        }}
      />
    </div>
  );
}
