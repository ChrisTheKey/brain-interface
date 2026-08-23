import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lastAssistantText,
  resolveTranscript,
  speakableText,
  speechCommand,
} from '../scripts/zero-say.mjs';

/**
 * Claude Code speaking out loud in this repository.
 *
 * Two halves that are easy to confuse: dictation *in* is Claude Code's own
 * feature and this repo only switches it on; spoken replies *out* do not exist
 * in the CLI and are what `scripts/zero-say.mjs` adds. These tests are about
 * the second half.
 *
 * The synthesiser is stubbed with a script that records what it was asked to
 * say, because a test that needs a speaker is a test that never runs in CI.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, 'scripts', 'zero-say.mjs');
const toggle = join(repoRoot, '.zero', 'run', 'voice-out');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* best effort */
    }
  }
  // Never leave the toggle on: the next developer would be talked at.
  if (existsSync(toggle)) rmSync(toggle, { force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in synthesiser that writes down what it was told to say. */
function fakeSpeaker(): { binDir: string; spoken: () => string } {
  const dir = scratch('zero-speaker-');
  const log = join(dir, 'spoken.txt');
  const binary = join(dir, 'spd-say');
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 });
  return {
    binDir: dir,
    spoken: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}

function runScript(args: string[], options: { input?: string; path?: string } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    input: options.input,
    env: options.path ? { ...process.env, PATH: `${options.path}:${process.env['PATH']}` } : process.env,
  });
}

function transcriptLine(text: string | null, kind: 'text' | 'tool_use' | 'thinking' = 'text') {
  const part =
    kind === 'text'
      ? { type: 'text', text }
      : kind === 'tool_use'
        ? { type: 'tool_use', name: 'Bash', input: {} }
        : { type: 'thinking', thinking: 'hmm' };
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [part] } });
}

// ------------------------------------------------------------- what is spoken

describe('what is worth reading aloud', () => {
  it('reads the prose and skips the code', () => {
    const markdown = [
      '# Der Titel',
      '',
      'Das hier ist die Antwort mit `inline code` darin.',
      '',
      '```bash',
      'export ZERO_TOKEN=streng-geheim-123',
      '```',
      '',
      '- erster Punkt',
      '- zweiter Punkt',
    ].join('\n');
    const spoken = speakableText(markdown);

    expect(spoken).toContain('Der Titel');
    expect(spoken).toContain('erster Punkt');
    // Listening to a diff is useless, and a token pasted into a code block is
    // the one thing that must never be read out across a room.
    expect(spoken).not.toContain('streng-geheim-123');
    expect(spoken).not.toContain('export');
    expect(spoken).not.toContain('```');
    expect(spoken).not.toContain('#');
    expect(spoken).not.toContain('- ');
  });

  it('keeps a link’s words and drops its address', () => {
    const spoken = speakableText('Siehe [die Doku](https://example.com/a/b) und https://raw.example/x.');
    expect(spoken).toContain('die Doku');
    expect(spoken).not.toContain('http');
    expect(spoken).not.toContain('example.com');
  });

  it('drops table rows rather than reading the pipes', () => {
    const spoken = speakableText('Text davor\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nText danach');
    expect(spoken).toBe('Text davor Text danach');
  });

  it('stops at a sentence rather than mid-word', () => {
    const sentence = 'Dies ist ein vollständiger Satz über ZERO. ';
    const spoken = speakableText(sentence.repeat(40));
    expect(spoken.length).toBeLessThanOrEqual(700);
    // Cut at a full stop, so the last thing heard is a finished thought.
    expect(spoken.endsWith('.')).toBe(true);
  });

  it('has nothing to say about an empty or code-only answer', () => {
    expect(speakableText('')).toBe('');
    expect(speakableText('```\njust code\n```')).toBe('');
    expect(speakableText(null as unknown as string)).toBe('');
  });
});

// ------------------------------------------------------------ the transcript

describe('finding the last thing Claude said', () => {
  it('takes the last reply that had words in it', async () => {
    const dir = scratch('zero-transcript-');
    const file = join(dir, 'session.jsonl');
    writeFileSync(
      file,
      [
        transcriptLine('erste Antwort'),
        transcriptLine('zweite Antwort'),
        // A tool call and a thought are not replies, and must not blank out
        // the answer that came before them.
        transcriptLine(null, 'tool_use'),
        transcriptLine(null, 'thinking'),
        '',
      ].join('\n'),
    );
    expect(await lastAssistantText(file)).toBe('zweite Antwort');
  });

  it('survives a half-written last line', async () => {
    // Normal while a session is live: the file is being appended to.
    const dir = scratch('zero-transcript-');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, `${transcriptLine('vollständig')}\n{"type":"assistant","messa`);
    expect(await lastAssistantText(file)).toBe('vollständig');
  });

  it('says nothing about a transcript that is not there', async () => {
    expect(await lastAssistantText('/nope/missing.jsonl')).toBe('');
    expect(await lastAssistantText('')).toBe('');
  });

  it('prefers the path the hook was given', () => {
    const dir = scratch('zero-transcript-');
    const file = join(dir, 'given.jsonl');
    writeFileSync(file, transcriptLine('x'));
    expect(resolveTranscript({ transcript_path: file })).toBe(file);
  });

  it('falls back to the newest transcript for this directory', () => {
    // A hook that silently speaks nothing is indistinguishable from a hook
    // that was never installed, so the fallback matters.
    const home = scratch('zero-home-');
    const cwd = '/home/someone/ZERO-WORKSPACE/brain-interface';
    const dir = join(home, '.claude', 'projects', cwd.replace(/[/\\:]/g, '-'));
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'older.jsonl');
    const newer = join(dir, 'newer.jsonl');
    writeFileSync(older, transcriptLine('alt'));
    writeFileSync(newer, transcriptLine('neu'));
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);

    expect(resolveTranscript({}, { home, cwd })).toBe(newer);
    expect(resolveTranscript({}, { home, cwd: '/somewhere/else' })).toBe('');
  });
});

// -------------------------------------------------------------- the speaker

describe('the synthesiser this machine has', () => {
  const never = () => false;
  const only = (name: string) => (candidate: string) => candidate === name;

  it('uses Termux’s own voice on the phone', () => {
    expect(speechCommand('hallo', { platformName: 'android', has: never })?.command).toBe(
      'termux-tts-speak',
    );
  });

  it('uses what Windows already ships, with no install', () => {
    // System.Speech is part of Windows; requiring a download to hear a reply
    // would put voice behind a dependency the ThinkPad does not need.
    const chosen = speechCommand('hallo', { platformName: 'win32', has: only('pwsh') });
    expect(chosen?.command).toBe('pwsh');
    expect(chosen?.args.join(' ')).toContain('System.Speech');
    // Text goes in on stdin, not on the command line: an answer with a quote
    // in it would otherwise break the PowerShell it is pasted into.
    expect(chosen?.stdin).toBe('hallo');
    expect(speechCommand('hallo', { platformName: 'win32', has: never })?.command).toBe('powershell');
  });

  it('takes whatever Linux has, in order', () => {
    expect(speechCommand('hallo', { platformName: 'linux', has: only('spd-say') })?.args).toEqual([
      '--wait',
      'hallo',
    ]);
    expect(speechCommand('hallo', { platformName: 'linux', has: only('espeak-ng') })?.command).toBe(
      'espeak-ng',
    );
  });

  it('reports having no voice rather than pretending', () => {
    expect(speechCommand('hallo', { platformName: 'linux', has: never })).toBe(null);
  });
});

// ------------------------------------------------------------------ the hook

describe('the Stop hook', () => {
  it('says nothing until it is switched on', () => {
    const speaker = fakeSpeaker();
    const result = runScript(['--hook'], { input: '{}', path: speaker.binDir });
    // A checked-in hook that talks to whoever clones the repo is a prank.
    expect(result.status).toBe(0);
    expect(speaker.spoken()).toBe('');
  });

  it('speaks the last reply once switched on', () => {
    const speaker = fakeSpeaker();
    const dir = scratch('zero-transcript-');
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, transcriptLine('Der Gateway läuft, das Backend nicht.'));

    runScript(['--on']);
    const result = runScript(['--hook'], {
      input: JSON.stringify({ transcript_path: file }),
      path: speaker.binDir,
    });
    expect(result.status).toBe(0);
    // The child is detached so the turn is not blocked; give it a moment.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !speaker.spoken()) {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
    }
    expect(speaker.spoken()).toContain('Der Gateway läuft');
  });

  it('never fails the turn, whatever is wrong', () => {
    runScript(['--on']);
    // No synthesiser, unreadable payload, missing transcript: all of these are
    // reasons to stay quiet, none is a reason to break the session.
    for (const input of ['{}', 'not json', '{"transcript_path":"/nope.jsonl"}', '']) {
      expect(runScript(['--hook'], { input }).status).toBe(0);
    }
  });

  it('turns on and off, and says which it is', () => {
    expect(runScript(['--on']).stdout).toContain('ON');
    expect(runScript(['--status']).stdout).toContain('voice output : ON');
    expect(runScript(['--off']).stdout).toContain('OFF');
    expect(runScript(['--status']).stdout).toContain('voice output : OFF');
    // The toggle lives under .zero/, which is gitignored: it is per checkout
    // and never travels with the repository.
    expect(runScript(['--status']).stdout).toContain(join('.zero', 'run', 'voice-out'));
  });
});

// ------------------------------------------------------------- configuration

describe('what the repository configures', () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8'));

  it('switches on the dictation Claude Code already has', () => {
    // Voice *in* is a Claude Code feature; this repo only enables it.
    expect(settings.voice.enabled).toBe(true);
    expect(settings.voice.mode).toBe('hold');
  });

  it('registers the Stop hook that adds the half Claude Code lacks', () => {
    const commands = settings.hooks.Stop.flatMap((entry: { hooks: { command?: string }[] }) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(commands).toContain('node scripts/zero-say.mjs --hook');
    // Asynchronous: nobody wants the next prompt blocked until a paragraph
    // has finished being read out.
    expect(settings.hooks.Stop[0].hooks[0].async).toBe(true);
  });

  it('ships a /voice command that explains both halves', () => {
    const command = readFileSync(join(repoRoot, '.claude', 'commands', 'voice.md'), 'utf8');
    for (const word of ['on', 'off', 'status', 'termux-tts-speak', 'System.Speech']) {
      expect(command).toContain(word);
    }
  });

  it('keeps the toggle out of git', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.zero/');
  });
});
