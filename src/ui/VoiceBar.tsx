/**
 * The conversation strip.
 *
 * One microphone, one text field, and the three things that actually matter
 * during a turn: what ZERO is hearing right now (the partial transcript), what
 * was handed over (the final transcript) and what came back (ZERO's answer).
 *
 * Partial and final are shown separately on purpose — a partial is the engine
 * still thinking, a final is the sentence HWD-ZERO was given, and collapsing
 * the two would hide which of them ZERO actually acted on.
 */
import { useState } from 'react';
import type { ZeroRuntimeState } from '../runtime/states';
import type { VoiceTier } from '../voice/ttsPipeline';

export interface VoiceBarProps {
  state: ZeroRuntimeState;
  listening: boolean;
  speechSupported: boolean;
  partial: string;
  finalTranscript: string;
  response: string;
  error: string | null;
  tier: VoiceTier;
  tierNote: string | null;
  estimated: boolean;
  /** Agents HWD-ZERO reports as running right now. */
  activeAgents: string[];
  onToggleListening: () => void;
  onSubmitText: (text: string) => void;
  onReplay: () => void;
}

export function VoiceBar({
  state,
  listening,
  speechSupported,
  partial,
  finalTranscript,
  response,
  error,
  tier,
  tierNote,
  estimated,
  activeAgents,
  onToggleListening,
  onSubmitText,
  onReplay,
}: VoiceBarProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const blocked = state === 'SAFE_MODE';

  return (
    <div className="voice-bar">
      <div className="voice-controls">
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
            placeholder={blocked ? 'SAFE MODE — nothing executes' : '…or write to ZERO'}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Message to ZERO"
            enterKeyHint="send"
          />
        </form>

        {response ? (
          <button type="button" className="text-button" onClick={onReplay}>
            replay
          </button>
        ) : null}
      </div>

      <div className="voice-transcript">
        {partial && partial !== finalTranscript ? (
          <p className="transcript transcript-partial" aria-live="polite">
            <span className="transcript-tag">hearing</span>
            {partial}
          </p>
        ) : null}
        {finalTranscript ? (
          <p className="transcript transcript-final">
            <span className="transcript-tag">said</span>
            {finalTranscript}
          </p>
        ) : null}
        {response ? (
          <p className="answer" aria-live="polite">
            <span className="transcript-tag">ZERO</span>
            {response}
          </p>
        ) : null}
      </div>

      <div className="voice-meta">
        {activeAgents.length > 0 ? (
          <span className="dim">running: {activeAgents.join(', ')}</span>
        ) : null}
        {estimated ? (
          <span className="warn" title={tierNote ?? undefined}>
            voice: {tier} · reaction estimated, not measured
          </span>
        ) : tier === 'none' ? (
          <span className="warn" title={tierNote ?? undefined}>
            no voice output
          </span>
        ) : null}
        {error ? <span className="warn">{error}</span> : null}
      </div>
    </div>
  );
}
