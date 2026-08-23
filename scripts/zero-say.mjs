#!/usr/bin/env node
/**
 * Claude Code speaking out loud, in this repository.
 *
 * Claude Code's own voice mode is dictation: you hold a key, you talk, it
 * types. It has no text-to-speech — nothing in the CLI reads a reply back to
 * you. This is the missing half, and it is deliberately small: take the last
 * thing Claude said, strip what nobody wants read aloud, and hand it to
 * whatever speech synthesiser this machine already has.
 *
 * Node rather than a shell script because this repository already requires
 * Node 20 on every platform it runs on — Termux, Windows and Linux — and a
 * bash version plus a PowerShell version of the same logic is two things to
 * keep in step.
 *
 *   node scripts/zero-say.mjs "text"     speak this
 *   node scripts/zero-say.mjs --hook     read Claude Code's Stop-hook JSON on
 *                                        stdin and speak the last reply
 *   node scripts/zero-say.mjs --dry-run  print what it would run, say nothing
 *   node scripts/zero-say.mjs --status   what this machine can do
 *
 * Two rules it keeps:
 *
 * **Silent unless switched on.** The Stop hook does nothing until
 * `.zero/run/voice-out` exists (`/voice on`). A repository that starts talking
 * at whoever clones it would be a prank, not a feature.
 *
 * **Never reads code out loud.** Fenced blocks, inline code and URLs are
 * removed before speaking — partly because listening to a diff is useless, and
 * partly because a token pasted into a code block is the one thing that must
 * not be broadcast across a room.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOGGLE = join(repoRoot, '.zero', 'run', 'voice-out');

/** Long answers are summarised by the ear giving up. Cut before that. */
const MAX_SPOKEN_CHARS = 700;

// ------------------------------------------------------------------ the text

/**
 * Markdown as something worth hearing.
 *
 * A spoken code block is noise, a spoken URL is worse, and a bullet read with
 * its dash is somehow both. What survives is the prose.
 */
export function speakableText(markdown) {
  if (!markdown) return '';
  let text = String(markdown);
  text = text.replace(/```[\s\S]*?```/g, ' ');       // fenced code
  text = text.replace(/`[^`\n]*`/g, ' ');            // inline code
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // links: keep the label
  text = text.replace(/https?:\/\/\S+/g, ' ');       // bare URLs
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');    // heading markers
  text = text.replace(/^\s*[-*+]\s+/gm, '');         // bullets
  text = text.replace(/^\s*\|.*\|\s*$/gm, ' ');      // table rows
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/^\s*[-=_]{3,}\s*$/gm, ' ');   // rules
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > MAX_SPOKEN_CHARS) {
    // Cut at a sentence end when there is one nearby, so it does not stop
    // mid-word.
    const cut = text.slice(0, MAX_SPOKEN_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = (lastStop > MAX_SPOKEN_CHARS * 0.6 ? cut.slice(0, lastStop + 1) : cut).trim();
  }
  return text;
}

/** The last thing Claude actually said, out of a transcript JSONL. */
export async function lastAssistantText(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  let latest = '';
  // Streamed rather than read whole: a long session's transcript is megabytes,
  // and this runs on every single turn.
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim() || !line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written last line is normal while a session is live
    }
    if (entry?.type !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim();
    // Tool calls and thinking are not replies. Only a turn that produced text
    // replaces the previous one.
    if (text) latest = text;
  }
  return latest;
}

/**
 * Which transcript this hook is about.
 *
 * `transcript_path` in the hook payload when it is there; otherwise the newest
 * transcript for this working directory, which is where Claude Code puts them.
 * The fallback matters: a hook that silently speaks nothing is indistinguishable
 * from a hook that is not installed.
 */
export function resolveTranscript(payload, { home = homedir(), cwd = repoRoot } = {}) {
  if (payload?.transcript_path && existsSync(payload.transcript_path)) {
    return payload.transcript_path;
  }
  if (process.env['CLAUDE_TRANSCRIPT_PATH'] && existsSync(process.env['CLAUDE_TRANSCRIPT_PATH'])) {
    return process.env['CLAUDE_TRANSCRIPT_PATH'];
  }
  const slug = cwd.replace(/[/\\:]/g, '-');
  const dir = join(home, '.claude', 'projects', slug);
  if (!existsSync(dir)) return '';
  let newest = '';
  let newestAt = 0;
  for (const name of readdirSafe(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    const at = statSafe(full);
    if (at > newestAt) {
      newestAt = at;
      newest = full;
    }
  }
  return newest;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statSafe(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// --------------------------------------------------------------- the speaker

/**
 * The speech command for this machine, or nothing.
 *
 * Ordered by how likely each is to be the *right* one rather than merely
 * present: Termux's own TTS on Android, the system voice on macOS, whatever
 * speech-dispatcher or espeak is on Linux, and PowerShell's built-in
 * synthesiser on Windows — which needs no install at all.
 */
export function speechCommand(text, { platformName = platform(), has = commandExists } = {}) {
  if (platformName === 'android' || has('termux-tts-speak')) {
    return { command: 'termux-tts-speak', args: [text] };
  }
  if (platformName === 'darwin' && has('say')) {
    return { command: 'say', args: [text] };
  }
  if (platformName === 'win32') {
    // System.Speech ships with Windows; nothing to install.
    const script =
      'Add-Type -AssemblyName System.Speech; ' +
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      '$s.Speak([Console]::In.ReadToEnd())';
    const shell = has('pwsh') ? 'pwsh' : 'powershell';
    return { command: shell, args: ['-NoProfile', '-Command', script], stdin: text };
  }
  for (const candidate of ['spd-say', 'espeak-ng', 'espeak', 'say']) {
    if (has(candidate)) {
      const args = candidate === 'spd-say' ? ['--wait', text] : [text];
      return { command: candidate, args };
    }
  }
  return null;
}

function commandExists(name) {
  const probe = platform() === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [name], { stdio: 'ignore' });
  return result.status === 0;
}

/** Speak, and never let a missing voice break the turn that called us. */
export function speak(text, { dryRun = false } = {}) {
  const spoken = speakableText(text);
  if (!spoken) return { spoken: false, reason: 'nothing to say' };
  const chosen = speechCommand(spoken);
  if (!chosen) {
    return { spoken: false, reason: 'no speech synthesiser on this machine' };
  }
  if (dryRun) {
    return { spoken: false, reason: 'dry run', command: chosen.command, text: spoken };
  }
  try {
    const child = spawn(chosen.command, chosen.args, {
      stdio: [chosen.stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'],
      detached: true,
    });
    if (chosen.stdin) {
      child.stdin.end(chosen.stdin);
    }
    // Detached on purpose: Claude Code waits for its hooks, and nobody wants
    // the next prompt blocked until a paragraph has finished being read.
    child.unref();
    return { spoken: true, command: chosen.command, text: spoken };
  } catch (error) {
    return { spoken: false, reason: String(error) };
  }
}

// ---------------------------------------------------------------- the toggle

export function voiceOutEnabled() {
  return existsSync(TOGGLE);
}

export function setVoiceOut(on) {
  const dir = dirname(TOGGLE);
  if (on) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(TOGGLE, new Date().toISOString(), 'utf8');
    return true;
  }
  try {
    if (existsSync(TOGGLE)) unlinkSync(TOGGLE);
  } catch {
    /* already off */
  }
  return false;
}

// ------------------------------------------------------------------- the CLI

async function main(argv) {
  const flags = new Set(argv.filter((value) => value.startsWith('--')));
  const words = argv.filter((value) => !value.startsWith('--'));

  if (flags.has('--on')) {
    setVoiceOut(true);
    process.stdout.write('voice output ON — Claude will read its replies aloud in this repo\n');
    return 0;
  }
  if (flags.has('--off')) {
    setVoiceOut(false);
    process.stdout.write('voice output OFF\n');
    return 0;
  }
  if (flags.has('--status')) {
    const chosen = speechCommand('probe');
    process.stdout.write(
      [
        `voice output : ${voiceOutEnabled() ? 'ON' : 'OFF'}`,
        `synthesiser  : ${chosen ? chosen.command : 'none found on this machine'}`,
        `toggle file  : ${TOGGLE}`,
      ].join('\n') + '\n',
    );
    return chosen ? 0 : 1;
  }

  if (flags.has('--hook')) {
    // Off by default. A checked-in hook that talks to everyone who clones the
    // repository would be a prank rather than a feature.
    if (!voiceOutEnabled()) return 0;
    const raw = await readStdin();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    const transcript = resolveTranscript(payload);
    const text = await lastAssistantText(transcript);
    speak(text, { dryRun: flags.has('--dry-run') });
    // Always 0: a hook that fails a turn because a speaker is missing has
    // made things worse than saying nothing.
    return 0;
  }

  const text = words.join(' ') || (await readStdin());
  const result = speak(text, { dryRun: flags.has('--dry-run') });
  if (flags.has('--dry-run')) {
    process.stdout.write(`${result.command ?? '(none)'}: ${result.text ?? ''}\n`);
  } else if (!result.spoken) {
    process.stderr.write(`${result.reason}\n`);
    return 1;
  }
  return 0;
}

function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) {
      done('');
      return;
    }
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
    });
    process.stdin.on('end', () => done(buffer));
    process.stdin.on('error', () => done(''));
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
