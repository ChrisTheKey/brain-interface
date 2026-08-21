import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/**
 * The regression this whole change exists to prevent.
 *
 * `ws://127.0.0.1:8787` in browser code is not a small bug. `127.0.0.1` means
 * *this device*: on the laptop that runs ZERO it happens to work, and on the
 * Samsung Galaxy it points the phone at the phone, which is why the interface
 * said "disconnected" while HWD-ZERO was running perfectly one machine away.
 *
 * So the rule is mechanical rather than a matter of care: nothing under `src/`
 * — everything under `src/` is compiled into the bundle the browser downloads —
 * may name a backend host, a backend port or a socket scheme. The gateway
 * knows where ZERO is. The browser knows `/api` and `/ws`.
 */

const SRC = resolve(__dirname, '..', 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry))) found.push(full);
  }
  return found;
}

/** Comments explain the rule; only real code may violate it. */
function codeLines(file: string): { line: number; text: string }[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const kept: { line: number; text: string }[] = [];
  let inBlockComment = false;
  lines.forEach((raw, index) => {
    let text = raw;
    if (inBlockComment) {
      const end = text.indexOf('*/');
      if (end === -1) return;
      text = text.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = text.indexOf('/*');
    if (blockStart !== -1) {
      const end = text.indexOf('*/', blockStart + 2);
      if (end === -1) {
        inBlockComment = true;
        text = text.slice(0, blockStart);
      } else {
        text = text.slice(0, blockStart) + text.slice(end + 2);
      }
    }
    const lineComment = text.indexOf('//');
    if (lineComment !== -1) text = text.slice(0, lineComment);
    if (text.trim() === '') return;
    kept.push({ line: index + 1, text });
  });
  return kept;
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  // The exact address that caused the bug.
  { name: 'ws://127.0.0.1:8787', pattern: /ws:\/\/127\.0\.0\.1:8787/ },
  // Any loopback literal, in any form.
  { name: 'a loopback address', pattern: /127\.0\.0\.1/ },
  { name: 'localhost', pattern: /\blocalhost\b/ },
  { name: '[::1]', pattern: /\[::1\]/ },
  // Any internal service port.
  { name: 'port 8787', pattern: /:8787\b/ },
  { name: 'port 8000', pattern: /:8000\b/ },
  { name: 'port 11434 (Ollama)', pattern: /:11434\b/ },
  // Any absolute socket URL at all: same origin is derived, never written down.
  { name: 'an absolute ws:// URL', pattern: /['"`]wss?:\/\//i },
];

describe('no backend address reaches the browser bundle', () => {
  const files = sourceFiles(SRC);

  it('finds the interface sources it is supposed to guard', () => {
    // A scanner that silently matches nothing would pass forever.
    expect(files.length).toBeGreaterThan(20);
  });

  for (const { name, pattern } of FORBIDDEN) {
    it(`never hardcodes ${name}`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        for (const { line, text } of codeLines(file)) {
          if (pattern.test(text)) {
            offenders.push(`${relative(SRC, file)}:${line}: ${text.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('builds its socket URL from window.location and nothing else', () => {
    const endpoints = readFileSync(join(SRC, 'zero', 'endpoints.ts'), 'utf8');
    expect(endpoints).toContain('location.host');
    expect(endpoints).toContain("'https:'");
  });
});

describe('the built bundle', () => {
  // Sources are one thing; what the phone actually downloads is another. When
  // a build exists, check the artefact itself — that is the file the Galaxy
  // executes, and no amount of clean source helps if a literal survives into it.
  const distAssets = resolve(__dirname, '..', 'dist', 'assets');
  let bundles: string[] = [];
  try {
    bundles = readdirSync(distAssets)
      .filter((entry) => entry.endsWith('.js'))
      .map((entry) => join(distAssets, entry));
  } catch {
    bundles = [];
  }

  it.skipIf(bundles.length === 0)('carries no internal backend address', () => {
    for (const bundle of bundles) {
      const code = readFileSync(bundle, 'utf8');
      expect(code).not.toContain('ws://127.0.0.1:8787');
      expect(code).not.toContain('127.0.0.1:8000');
      expect(code).not.toMatch(/ws:\/\/127\.0\.0\.1/);
    }
  });
});
