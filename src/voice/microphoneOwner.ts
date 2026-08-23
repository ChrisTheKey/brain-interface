/**
 * One microphone, however many things are listening to it.
 *
 * Wake listening and a push-to-talk turn both want the device, and for a
 * moment during a wake-triggered command they want it at the same time. Two
 * `getUserMedia` calls would mean two tracks, two AudioContexts, two recording
 * indicators and — on a phone — two chances for Android to hand one of them
 * back empty.
 *
 * So the device is opened once and fanned out. The last subscriber to leave
 * turns it off, which is the part that matters: a microphone still running
 * after the thing that wanted it has gone is a light on the operator's phone
 * that nobody can explain.
 */
import {
  MicrophoneError,
  openMicrophone,
  type MicrophoneHandlers,
  type MicrophoneStream,
} from './microphone';

export interface MicrophoneSubscription {
  /** Leave. The device closes when the last subscriber does. */
  release: () => void;
  /** What the device actually gave us, for diagnostics. */
  sampleRate: number;
}

type Opener = typeof openMicrophone;

interface OwnerState {
  stream: MicrophoneStream | null;
  opening: Promise<MicrophoneStream> | null;
  subscribers: Set<MicrophoneHandlers>;
}

const state: OwnerState = { stream: null, opening: null, subscribers: new Set() };

/** Test seam. Never used in the browser. */
let opener: Opener = openMicrophone;
export function setMicrophoneOpener(next: Opener | null): void {
  opener = next ?? openMicrophone;
}

function fanOut(): MicrophoneHandlers {
  return {
    onChunk: (pcm16) => {
      // A copy per subscriber would double the allocation on every 250 ms
      // frame; the contract is that nobody mutates what they are handed.
      for (const handler of [...state.subscribers]) {
        try {
          handler.onChunk(pcm16);
        } catch {
          /* one bad listener must not deafen the others */
        }
      }
    },
    onLevel: (level) => {
      for (const handler of [...state.subscribers]) {
        try {
          handler.onLevel?.(level);
        } catch {
          /* as above */
        }
      }
    },
    onError: (error) => {
      for (const handler of [...state.subscribers]) {
        try {
          handler.onError?.(error);
        } catch {
          /* as above */
        }
      }
    },
  };
}

/**
 * Listen to the microphone, opening it if this is the first ask.
 *
 * Concurrent callers share the one in-flight open rather than racing two
 * permission prompts past the operator.
 */
export async function subscribeMicrophone(
  handlers: MicrophoneHandlers,
): Promise<MicrophoneSubscription> {
  state.subscribers.add(handlers);
  try {
    if (!state.stream) {
      state.opening = state.opening ?? opener(fanOut());
      state.stream = await state.opening;
      state.opening = null;
    }
  } catch (error) {
    state.subscribers.delete(handlers);
    state.opening = null;
    throw error instanceof MicrophoneError
      ? error
      : new MicrophoneError(String(error), 'audio_error');
  }

  let released = false;
  return {
    sampleRate: state.stream.sampleRate,
    release: () => {
      if (released) return;
      released = true;
      state.subscribers.delete(handlers);
      if (state.subscribers.size === 0) {
        state.stream?.stop();
        state.stream = null;
      }
    },
  };
}

/** Is the device open right now? Diagnostics only. */
export function microphoneIsOpen(): boolean {
  return state.stream !== null;
}

/** How many things are listening. Diagnostics, and a guard in tests. */
export function microphoneSubscriberCount(): number {
  return state.subscribers.size;
}

/** Close the device regardless of subscribers. Used on teardown. */
export function releaseMicrophone(): void {
  state.subscribers.clear();
  state.stream?.stop();
  state.stream = null;
  state.opening = null;
}
