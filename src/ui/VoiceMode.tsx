/**
 * Voice mode — the interface at `/voice`.
 *
 * The brain is the interface everywhere else. Here it is the conversation:
 * one orb that shows what ZERO is actually doing, what it heard, what it
 * answered, and which voice is speaking. Nothing decorative moves — the orb
 * follows the real microphone level while listening and the real playback
 * amplitude while ZERO speaks, so what you see is the signal, not a loop.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AudioLevels } from '../audio/analyser';
import type { ConversationState } from '../state/conversation';

export interface VoiceModeProps {
  state: ConversationState;
  listening: boolean;
  conversationActive: boolean;
  speechSupported: boolean;
  transcript: string;
  answer: string;
  error: string | null;
  activeAgents: string[];
  /** Which provider ZERO is speaking through right now. */
  voiceProviderId: string | null;
  voiceReason: string | undefined;
  connection: string;
  /** Real input level while listening, 0..1. */
  micLevel: () => number;
  /** Real playback levels while ZERO speaks. */
  levels: () => AudioLevels;
  onToggleConversation: () => void;
  onPushToTalk: () => void;
  onSubmitText: (text: string) => void;
  onExit: () => void;
}

const STATE_LABEL: Record<ConversationState, string> = {
  idle: 'ready',
  listening: 'listening',
  processing: 'thinking',
  agentActive: 'agents working',
  speaking: 'speaking',
  error: 'error',
};

const PROVIDER_LABEL: Record<string, string> = {
  'zero-realtime': 'ZERO realtime',
  'fish-audio': 'Fish Audio',
  'speech-synthesis': 'browser voice',
};

export function VoiceMode({
  state,
  listening,
  conversationActive,
  speechSupported,
  transcript,
  answer,
  error,
  activeAgents,
  voiceProviderId,
  voiceReason,
  connection,
  micLevel,
  levels,
  onToggleConversation,
  onPushToTalk,
  onSubmitText,
  onExit,
}: VoiceModeProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const orbRef = useRef<HTMLDivElement | null>(null);

  // The orb is driven from a frame loop rather than from React state: this is
  // a per-frame signal, and re-rendering the tree 60 times a second to move a
  // circle would be the wrong trade.
  useEffect(() => {
    let frame = 0;
    let smoothed = 0;
    const tick = (): void => {
      const raw = listening ? micLevel() : state === 'speaking' ? levels().amplitude : 0;
      smoothed += (raw - smoothed) * 0.25;
      const element = orbRef.current;
      if (element) {
        element.style.setProperty('--voice-level', smoothed.toFixed(4));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [listening, state, micLevel, levels]);

  const providerLabel = useMemo(() => {
    if (!voiceProviderId) return null;
    return PROVIDER_LABEL[voiceProviderId] ?? voiceProviderId;
  }, [voiceProviderId]);

  return (
    <section className="voice-mode" aria-label="Voice mode">
      <header className="voice-mode-head">
        <button type="button" className="voice-exit" onClick={onExit}>
          ← brain
        </button>
        <span className={`conversation-state state-${state}`}>ZERO {STATE_LABEL[state]}</span>
        <span className="dim">{connection}</span>
      </header>

      <div className="voice-stage">
        <div
          ref={orbRef}
          className={`voice-orb voice-orb-${state} ${conversationActive ? 'voice-orb-live' : ''}`}
          aria-hidden="true"
        >
          <span className="voice-orb-core" />
          <span className="voice-orb-ring" />
        </div>

        <p className="voice-transcript" aria-live="polite">
          {transcript ? `“${transcript}”` : listening ? 'listening…' : 'say something'}
        </p>

        {activeAgents.length > 0 ? (
          <p className="voice-agents">running: {activeAgents.join(', ')}</p>
        ) : null}

        {answer && state !== 'listening' ? (
          <p className="voice-answer" aria-live="polite">
            {answer}
          </p>
        ) : null}

        {error ? <p className="voice-error warn">{error}</p> : null}
      </div>

      <footer className="voice-mode-foot">
        <button
          type="button"
          className={`voice-main-button ${conversationActive ? 'voice-main-active' : ''}`}
          onClick={onToggleConversation}
          disabled={!speechSupported}
          aria-pressed={conversationActive}
          title={
            speechSupported
              ? 'Voice mode keeps listening after every answer'
              : 'This browser has no SpeechRecognition engine — type instead'
          }
        >
          <span className="mic-dot" aria-hidden="true" />
          {conversationActive ? 'end conversation' : 'start conversation'}
        </button>

        <button
          type="button"
          className="voice-secondary-button"
          onClick={onPushToTalk}
          disabled={!speechSupported || conversationActive}
          title="One turn, then the microphone closes again"
        >
          {listening && !conversationActive ? 'listening…' : 'push to talk'}
        </button>

        <form
          className="voice-input"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (text.length === 0) return;
            setDraft('');
            onSubmitText(text);
          }}
        >
          <input
            type="text"
            value={draft}
            placeholder="…or write to ZERO"
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Message to ZERO"
          />
        </form>

        <span className="dim voice-provider">
          {providerLabel ? `voice: ${providerLabel}` : 'voice: not started'}
          {voiceReason ? ` — ${voiceReason}` : ''}
        </span>
      </footer>
    </section>
  );
}
