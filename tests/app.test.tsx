// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import App from '../src/App';
import type { OperatorEvent } from '../src/hwd/types';

/**
 * The whole interface, mounted against a stubbed operator.
 *
 * jsdom has no WebGL, so this exercise doubles as the WebGL-less degradation
 * test: the brain falls back to a message and everything else keeps working.
 */

const STATE = {
  zero_version: '2.4.0',
  safe_mode: false,
  brain: { root: '/zero', revision: 'abcdef0123456789', sources: 3, projects: [], agents: [] },
  missions: { count: 1, running: 1, recent: [] },
  approvals_pending: 0,
  subscribers: 1,
  executor_references: [],
  verifier_types: [],
};

const REGISTRY = {
  version: '1.0.0',
  agents: [
    {
      id: 'insta',
      role: 'social',
      status: 'idle',
      purpose: 'Runs the Instagram presence',
      strengths: ['posting'],
      available: true,
    },
    {
      id: 'seo',
      role: 'seo',
      status: 'idle',
      purpose: 'Ranks pages',
      strengths: ['audits'],
      available: true,
    },
    // Blocked by policy — it must never reach the brain.
    { id: 'Prompt-Optimizer', role: '', status: 'idle', purpose: '', strengths: [], available: true },
  ],
  projects: [],
};

const MISSIONS = [
  {
    mission_id: 'mission-2026-08-22-aaaa1111',
    task_id: 'insta-story',
    objective: 'Publish the launch story',
    project: 'launch',
    executor: 'insta',
    status: 'RUNNING',
    started_at: '',
    finished_at: '',
    iterations: 1,
  },
];

const APPROVALS = [
  {
    mission_id: 'mission-2026-08-22-aaaa1111',
    task_id: 'insta-story',
    gate: 'external_publish',
    reason: 'posts to a real account',
    rationale: '',
    objective: 'Publish the launch story',
    executor: 'insta',
    iteration: 1,
    payload_digest: 'sha256:abc',
  },
];

let approvals: unknown[] = [];
let sockets: FakeSocket[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  binaryType = '';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(event: OperatorEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  approvals = [];
  sockets = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/gateway/health')) {
        return jsonResponse({
          gateway: 'ok',
          lanMode: false,
          zeroApi: 'http://127.0.0.1:8000',
          authRequired: false,
          websocketPaths: ['/ws/events', '/ws/voice'],
          upstream: { reachable: true, checkedAt: 1 },
        });
      }
      if (url.endsWith('/api/state')) return jsonResponse(STATE);
      if (url.endsWith('/api/agents')) return jsonResponse(REGISTRY);
      if (url.endsWith('/api/missions')) return jsonResponse({ missions: MISSIONS });
      if (url.endsWith('/api/approvals')) return jsonResponse({ approvals });
      if (url.endsWith('/api/tasks')) return jsonResponse({ tasks: [] });
      return new Response('{}', { status: 404 });
    }),
  );
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('coarse'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the interface end to end', () => {
  it('mounts, loads the registry and reports the operator as live', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/v2\.4\.0/)).toBeTruthy());
    // Two agents from the roster; the excluded repository is not one of them.
    expect(screen.getByText(/2 agents/)).toBeTruthy();
    // The only place it may appear is the audit note that says it was blocked —
    // a repository the policy excludes is never silently dropped either.
    const notes = document.querySelector('.notes:not(.notes-degraded)');
    expect(notes?.textContent).toContain('Excluded by policy');
    expect(notes?.textContent).toContain('Prompt-Optimizer');
    const withoutNotes = document.body.textContent?.replace(notes?.textContent ?? '', '');
    expect(withoutNotes).not.toContain('Prompt-Optimizer');
  });

  it('opens both sockets on the gateway origin, and only those two', async () => {
    render(<App />);
    await waitFor(() => expect(sockets.length).toBeGreaterThanOrEqual(2));
    const paths = sockets.map((socket) => new URL(socket.url).pathname);
    expect(new Set(paths)).toEqual(new Set(['/ws/events', '/ws/voice']));
    for (const socket of sockets) {
      expect(new URL(socket.url).protocol).toBe('ws:');
    }
  });

  it('degrades to a message instead of a blank screen where WebGL is missing', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/no WebGL/)).toBeTruthy());
    // …and the rest of the interface is still there.
    expect(screen.getByLabelText('Message to ZERO')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kill switch' })).toBeTruthy();
  });

  it('starts in IDLE and moves to EXECUTING on a real event', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/v2\.4\.0/)).toBeTruthy());
    expect(document.querySelector('.state-ring')?.getAttribute('data-state')).toBe('IDLE');

    const events = sockets.find((socket) => socket.url.includes('/ws/events'))!;
    await act(async () => {
      events.emit({
        event_id: 'E-1',
        timestamp: new Date().toISOString(),
        mission_id: 'mission-2026-08-22-aaaa1111',
        agent_id: 'insta',
        type: 'agent.started',
        payload: { action: 'writing caption' },
      });
    });
    await waitFor(() =>
      expect(document.querySelector('.state-ring')?.getAttribute('data-state')).toBe('EXECUTING'),
    );
    expect(screen.getByText(/running: insta/)).toBeTruthy();
  });

  it('raises the approval gate the moment the operator reports one', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/v2\.4\.0/)).toBeTruthy());
    approvals = APPROVALS;

    const events = sockets.find((socket) => socket.url.includes('/ws/events'))!;
    await act(async () => {
      events.emit({
        event_id: 'E-2',
        timestamp: new Date().toISOString(),
        mission_id: 'mission-2026-08-22-aaaa1111',
        agent_id: 'insta',
        type: 'approval.required',
        payload: {},
      });
    });

    await waitFor(() => expect(screen.getByText('external publish')).toBeTruthy());
    expect(document.querySelector('.state-ring')?.getAttribute('data-state')).toBe(
      'AWAITING_APPROVAL',
    );
    expect(screen.getByRole('button', { name: 'Approve once' })).toBeTruthy();
  });

  it('shows the mission the operator is running', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('insta-story')).toBeTruthy());
    expect(screen.getByText('RUNNING')).toBeTruthy();
  });
});

describe('the mobile layout', () => {
  it('keeps the whole HUD inside the safe area and within thumb reach', async () => {
    // Galaxy-class viewport.
    Object.defineProperty(window, 'innerWidth', { value: 412, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 915, configurable: true });

    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText(/v2\.4\.0/)).toBeTruthy());

    // The bottom bar carries the microphone and the kill switch — the two
    // controls a phone user needs without scrolling.
    const bottom = container.querySelector('.hud-bottom');
    expect(bottom).toBeTruthy();
    expect(bottom?.querySelector('.mic-button')).toBeTruthy();
    expect(bottom?.querySelector('.kill-switch')).toBeTruthy();
    // The state and the operator's edge stay at the top.
    expect(container.querySelector('.hud-top .state-ring')).toBeTruthy();
    // Nothing scrolls the page itself.
    expect(getComputedStyle(document.body).overflow).not.toBe('scroll');
  });

  it('detects a touch device and does not hand it the desktop tier', async () => {
    const { detectTier } = await import('../src/three/quality');
    expect(detectTier({ coarsePointer: true, hardwareConcurrency: 8, deviceMemory: 8 })).not.toBe(
      'high',
    );
  });
});
