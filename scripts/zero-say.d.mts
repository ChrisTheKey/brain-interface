/** Types for the speaker, which is plain Node ESM so it needs no build step. */

/** The command this machine would use to speak, and how to feed it text. */
export interface SpeechCommand {
  command: string;
  args: string[];
  /** Present when the text goes in on stdin rather than on the command line. */
  stdin?: string;
}

export interface SpeechCommandOptions {
  /** Overridden in tests; defaults to `os.platform()`. */
  platformName?: string;
  /** Overridden in tests; defaults to a `which`/`where` probe. */
  has?: (name: string) => boolean;
}

export interface SpokenResult {
  spoken: boolean;
  reason?: string;
  command?: string;
  text?: string;
}

export interface TranscriptLookupOptions {
  home?: string;
  cwd?: string;
}

/** Markdown as something worth hearing: prose in, code and URLs gone. */
export function speakableText(markdown: string | null | undefined): string;

/** The last reply that actually had words in it, out of a transcript JSONL. */
export function lastAssistantText(transcriptPath: string): Promise<string>;

/** The transcript this hook is about: the given path, or the newest for this cwd. */
export function resolveTranscript(
  payload: { transcript_path?: string } | null | undefined,
  options?: TranscriptLookupOptions,
): string;

/** What this machine can speak with, or null when it has no voice. */
export function speechCommand(text: string, options?: SpeechCommandOptions): SpeechCommand | null;

/** Speak, detached, and never let a missing voice break the calling turn. */
export function speak(text: string, options?: { dryRun?: boolean }): SpokenResult;

/** Is spoken output switched on for this checkout? */
export function voiceOutEnabled(): boolean;

/** Switch spoken output on or off for this checkout. */
export function setVoiceOut(on: boolean): boolean;
