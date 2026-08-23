/**
 * The conversation strip: press to speak, watch ZERO hear you, read the answer.
 *
 * The input field and the transcript are the same surface on purpose. What
 * ZERO heard belongs where what you type would go, because they are the same
 * request taking the same path — showing them in separate places would suggest
 * two pipelines, and there is only one.
 *
 * Nothing here disappears on its own. The last final transcript and ZERO's
 * answer stay visible: a spoken command that scrolls away the moment it is
 * understood leaves no way to check what was actually heard.
 */
import { useEffect, useRef, useState } from 'react';
import type { VoiceTurnApi, VoiceTurnState } from '../state/useVoiceTurn';
import { wakeLabelFor, type WakeWordApi } from '../state/useWakeWord';

export interface VoiceBarProps {
  voice: VoiceTurnApi;
  /** Hands-free. Optional: the bar works exactly as before without it. */
  wake?: WakeWordApi;
  /** Push-to-talk is the safe default; a tap toggles on touch devices. */
  onInterrupt: () => void;
}

/** What the operator is told, per state. Short, and never a spinner's worth of nothing. */
const LABELS: Record<VoiceTurnState, string> = {
  idle: 'speak',
  listening: 'LISTENING',
  transcribing: 'FINALIZING',
  understanding: 'UNDERSTANDING…',
  executing: 'EXECUTING',
  speaking: 'ZERO SPEAKING',
  error: 'VOICE ERROR',
};

export function VoiceBar({ voice, wake, onInterrupt }: VoiceBarProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const holding = useRef(false);

  // Space bar as push-to-talk, but never while typing into the field.
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTyping(event.target)) return;
      event.preventDefault();
      holding.current = true;
      voice.start();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || !holding.current) return;
      holding.current = false;
      voice.stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [voice]);

  const listening = voice.state === 'listening';
  const speaking = voice.state === 'speaking';

  return (
    <div className={`voice-bar voice-${voice.state}`}>
      {/*
        The transcript panel. Partial text is dimmer and italic because it is
        still being revised; the final transcript is plain, because it is what
        ZERO actually received.
      */}
      {(voice.partial || wake?.partial || voice.finalTranscript || voice.answer) && (
        <div className="transcript" aria-live="polite">
          {voice.partial || wake?.partial ? (
            <p className="transcript-partial">
              <span className="transcript-label">
                {wake?.state === 'command' && !voice.partial ? 'HEY ZERO' : 'LISTENING'}
              </span>
              <span className="transcript-dot" aria-hidden="true" />
              <span className="transcript-text">{voice.partial || wake?.partial}</span>
            </p>
          ) : null}

          {voice.finalTranscript && !voice.partial ? (
            <p className="transcript-final">
              <span className="transcript-label">HEARD</span>
              <span className="transcript-text">{voice.finalTranscript}</span>
            </p>
          ) : null}

          {voice.state === 'understanding' ? (
            <p className="transcript-status">UNDERSTANDING…</p>
          ) : null}

          {voice.answer ? (
            <p className="transcript-answer">
              <span className="transcript-label">ZERO</span>
              <span className="transcript-text">{voice.answer}</span>
            </p>
          ) : null}

          {voice.awaitingApproval ? (
            <p className="transcript-gate">
              AWAITING APPROVAL — nothing has been sent. Approve it in the operator panel.
            </p>
          ) : null}

          {wake?.error && !voice.error ? (
            <p className="transcript-error">
              <span className="transcript-label">{wake.error.code.replace(/_/g, ' ')}</span>
              <span className="transcript-text">{wake.error.detail}</span>
            </p>
          ) : null}

          {/* Never a generic "voice failed": the code and the remedy. */}
          {voice.error ? (
            <p className="transcript-error">
              <span className="transcript-label">{voice.error.code.replace(/_/g, ' ')}</span>
              <span className="transcript-text">{voice.error.remedy}</span>
            </p>
          ) : null}
        </div>
      )}

      <div className="voice-controls">
        {wake ? (
          /*
            Hands-free is opt-in and stays that way. A microphone that starts
            listening because a page loaded is not a feature anyone asked for,
            so this is a switch the operator throws — and the label says what
            it is doing rather than only that it is on.
          */
          <button
            type="button"
            className={`wake-toggle ${wake.enabled ? `wake-${wake.state}` : 'wake-off'}`}
            onClick={wake.toggle}
            aria-pressed={wake.enabled}
            title={
              wake.enabled
                ? 'Hands-free is on. Say "Hey ZERO", then your instruction.'
                : 'Switch on hands-free listening for "Hey ZERO".'
            }
          >
            <span className="wake-dot" aria-hidden="true" />
            {wakeLabelFor(wake.enabled, wake.state)}
          </button>
        ) : null}
        <button
          type="button"
          className={`speak-button ${listening ? 'speak-listening' : ''}`}
          // Push-to-talk: held down, released to finalize. Pointer events cover
          // mouse and touch with one path.
          onPointerDown={(event) => {
            event.preventDefault();
            voice.start();
          }}
          onPointerUp={() => voice.stop()}
          onPointerLeave={() => {
            if (listening) voice.stop();
          }}
          aria-pressed={listening}
        >
          <span className="speak-dot" aria-hidden="true" />
          {LABELS[voice.state]}
        </button>

        {speaking ? (
          <button type="button" className="text-button stop-button" onClick={onInterrupt}>
            stop
          </button>
        ) : null}

        <form
          className="voice-input"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text) return;
            setDraft('');
            // The identical pipeline. Typing is not a lesser path.
            voice.submitText(text);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={listening ? 'listening…' : '…or write to ZERO'}
            aria-label="Write to ZERO"
            disabled={listening}
          />
        </form>
      </div>
    </div>
  );
}
