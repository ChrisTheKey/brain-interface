/**
 * The conversation strip: microphone control, ZERO's state, the live
 * transcript and the answer. Deliberately one quiet line — the brain stays
 * the interface.
 */
import { useState } from 'react';
import type { ConversationState } from '../state/conversation';

export interface VoiceBarProps {
  state: ConversationState;
  listening: boolean;
  speechSupported: boolean;
  transcript: string;
  answer: string;
  error: string | null;
  activeAgents: string[];
  onToggleListening: () => void;
  onSubmitText: (text: string) => void;
}

const STATE_LABEL: Record<ConversationState, string> = {
  idle: 'idle',
  listening: 'listening',
  processing: 'thinking',
  agentActive: 'agents working',
  speaking: 'speaking',
  error: 'error',
};

export function VoiceBar({
  state,
  listening,
  speechSupported,
  transcript,
  answer,
  error,
  activeAgents,
  onToggleListening,
  onSubmitText,
}: VoiceBarProps): React.JSX.Element {
  const [draft, setDraft] = useState('');

  return (
    <div className="voice-bar">
      <button
        type="button"
        className={`mic-button ${listening ? 'mic-listening' : ''}`}
        onClick={onToggleListening}
        disabled={!speechSupported}
        aria-pressed={listening}
        title={
          speechSupported
            ? 'Speak to ZERO'
            : 'This browser has no SpeechRecognition engine — type instead'
        }
      >
        <span className="mic-dot" aria-hidden="true" />
        {listening ? 'listening…' : 'speak'}
      </button>

      <span className={`conversation-state state-${state}`}>ZERO {STATE_LABEL[state]}</span>

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

      {activeAgents.length > 0 ? (
        <span className="dim">running: {activeAgents.join(', ')}</span>
      ) : null}

      {transcript ? <span className="transcript">“{transcript}”</span> : null}
      {answer && state !== 'listening' ? <span className="answer">{answer}</span> : null}
      {error ? <span className="warn">{error}</span> : null}
    </div>
  );
}
