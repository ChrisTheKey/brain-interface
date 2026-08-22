// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApprovalGate } from '../src/ui/ApprovalGate';
import { AgentDetail } from '../src/ui/AgentDetail';
import { StateRing } from '../src/ui/StateRing';
import { SystemBar } from '../src/ui/SystemBar';
import { VoiceBar } from '../src/ui/VoiceBar';
import { buildBrain } from '../src/brain/build';
import { RUNTIME_STATES } from '../src/runtime/states';
import { profileFor } from '../src/three/quality';
import type { OperatorApproval, OperatorRegistry } from '../src/hwd/types';

afterEach(cleanup);

const APPROVAL: OperatorApproval = {
  mission_id: 'mission-2026-08-22-a1b2c3d4',
  task_id: 'insta-story',
  gate: 'external_publish',
  reason: 'posts to a real Instagram account',
  rationale: 'The account is customer facing and the post cannot be recalled.',
  objective: 'Publish the launch story',
  executor: 'insta',
  iteration: 2,
  payload_digest: 'sha256:abc',
};

const REGISTRY: OperatorRegistry = {
  version: '1.0.0',
  agents: [
    {
      id: 'insta',
      role: 'social',
      status: 'idle',
      purpose: 'Runs the Instagram presence',
      strengths: ['posting', 'dm'],
      available: true,
    },
  ],
  projects: [],
};

describe('the approval gate', () => {
  it('shows exactly what HWD-ZERO is stopped on', () => {
    render(<ApprovalGate approvals={[APPROVAL]} safeMode={false} onApprove={() => undefined} />);
    expect(screen.getByText('external publish')).toBeTruthy();
    expect(screen.getByText('Publish the launch story')).toBeTruthy();
    expect(screen.getByText('posts to a real Instagram account')).toBeTruthy();
    expect(screen.getByText(/blocked agent: insta/)).toBeTruthy();
  });

  it('approves the exact gate the human was shown', () => {
    const approve = vi.fn();
    render(<ApprovalGate approvals={[APPROVAL]} safeMode={false} onApprove={approve} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }));
    expect(approve).toHaveBeenCalledWith(APPROVAL);
  });

  it('offers no way to deny — an unapproved gate simply stays closed', () => {
    render(<ApprovalGate approvals={[APPROVAL]} safeMode={false} onApprove={() => undefined} />);
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels).toEqual(['Approve once']);
  });

  it('refuses to approve while the kill switch is on', () => {
    render(<ApprovalGate approvals={[APPROVAL]} safeMode onApprove={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Approve once' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/SAFE MODE is on/)).toBeTruthy();
  });

  it('counts a queue instead of rendering it', () => {
    const many = [APPROVAL, { ...APPROVAL, gate: 'b' }, { ...APPROVAL, gate: 'c' }];
    render(<ApprovalGate approvals={many} safeMode={false} onApprove={() => undefined} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText(/1 more gate waiting/)).toBeTruthy();
  });

  it('renders nothing at all when no gate is open', () => {
    const { container } = render(
      <ApprovalGate approvals={[]} safeMode={false} onApprove={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('the kill switch', () => {
  const bar = (safeMode: boolean, reachable: boolean, onToggle = vi.fn()) =>
    render(
      <SystemBar
        connection={reachable ? 'open' : 'unreachable'}
        error=""
        state={null}
        gateway={{
          gateway: 'ok',
          lanMode: false,
          zeroApi: 'http://127.0.0.1:8000',
          authRequired: false,
          websocketPaths: ['/ws/events', '/ws/voice'],
          upstream: { reachable, checkedAt: 1 },
        }}
        channelStatus="open"
        quality={profileFor('medium')}
        agents={1}
        notes={[]}
        degradations={[]}
        safeMode={safeMode}
        onToggleSafeMode={onToggle}
        onRefresh={() => undefined}
      />,
    );

  it('turns SAFE MODE on through HWD-ZERO, never locally', () => {
    const toggle = vi.fn();
    bar(false, true, toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Kill switch' }));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('says it is on, and offers the way back off', () => {
    bar(true, true);
    expect(screen.getByRole('button', { name: /SAFE MODE — nothing executes/ })).toBeTruthy();
  });

  it('cannot be set while the operator is unreachable — the switch lives there', () => {
    bar(false, false);
    expect(screen.getByRole('button', { name: 'Kill switch' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('HWD-ZERO offline')).toBeTruthy();
  });

  it('names a missing backend contract rather than hiding the gap', () => {
    render(
      <SystemBar
        connection="open"
        error=""
        state={null}
        gateway={null}
        channelStatus="unavailable"
        quality={null}
        agents={0}
        notes={[]}
        degradations={['Missing contract: WS /ws/voice.']}
        safeMode={false}
        onToggleSafeMode={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText('1 missing backend contract')).toBeTruthy();
    expect(screen.getByText('Missing contract: WS /ws/voice.')).toBeTruthy();
  });
});

describe('the conversation strip', () => {
  const voiceBar = (overrides: Partial<React.ComponentProps<typeof VoiceBar>> = {}) =>
    render(
      <VoiceBar
        state="LISTENING"
        listening
        speechSupported
        partial="starte den Scraper für"
        finalTranscript=""
        response=""
        error={null}
        tier="stream"
        tierNote={null}
        estimated={false}
        activeAgents={[]}
        onToggleListening={() => undefined}
        onSubmitText={() => undefined}
        onReplay={() => undefined}
        {...overrides}
      />,
    );

  it('shows the live partial transcript while ZERO is still hearing', () => {
    voiceBar();
    expect(screen.getByText('hearing')).toBeTruthy();
    expect(screen.getByText(/starte den Scraper für/)).toBeTruthy();
  });

  it('keeps the final transcript separate from the partial one', () => {
    voiceBar({
      state: 'THINKING',
      listening: false,
      partial: 'starte den Scraper für Hamburg',
      finalTranscript: 'starte den Scraper für Hamburg',
    });
    // Once the partial equals the final, only the handed-over sentence remains.
    expect(screen.queryByText('hearing')).toBeNull();
    expect(screen.getByText('said')).toBeTruthy();
  });

  it('shows ZERO’s real answer and offers to replay it', () => {
    const replay = vi.fn();
    voiceBar({ state: 'SPEAKING', listening: false, response: 'Der Scraper läuft.', onReplay: replay });
    expect(screen.getByText('Der Scraper läuft.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'replay' }));
    expect(replay).toHaveBeenCalled();
  });

  it('warns when the reaction is estimated rather than measured', () => {
    voiceBar({ tier: 'synthesis', estimated: true, tierNote: 'browser voice' });
    expect(screen.getByText(/reaction estimated, not measured/)).toBeTruthy();
  });

  it('offers typing when the browser has no speech engine', () => {
    voiceBar({ speechSupported: false, listening: false });
    expect(screen.getByRole('button', { name: /speak/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Message to ZERO')).toBeTruthy();
  });

  it('sends a typed request through the same pipeline', () => {
    const submit = vi.fn();
    voiceBar({ onSubmitText: submit });
    const input = screen.getByLabelText('Message to ZERO');
    fireEvent.change(input, { target: { value: 'status' } });
    fireEvent.submit(input);
    expect(submit).toHaveBeenCalledWith('status');
  });
});

describe('the runtime state ring', () => {
  it('renders every one of the eleven states', () => {
    for (const state of RUNTIME_STATES) {
      const { container, unmount } = render(<StateRing state={state} />);
      const ring = container.querySelector('.state-ring');
      expect(ring?.getAttribute('data-state')).toBe(state);
      expect(ring?.className).toContain(`state-${state.toLowerCase()}`);
      unmount();
    }
  });

  it('marks the two states where a human is genuinely required', () => {
    for (const state of ['AWAITING_APPROVAL', 'ERROR', 'SAFE_MODE'] as const) {
      const { container, unmount } = render(<StateRing state={state} />);
      expect(container.querySelector('.state-demands')).toBeTruthy();
      unmount();
    }
    const { container } = render(<StateRing state="EXECUTING" />);
    expect(container.querySelector('.state-demands')).toBeNull();
  });
});

describe('the agent detail card', () => {
  const graph = buildBrain(REGISTRY);
  const hub = graph.nodes.find((node) => node.kind === 'agent')!;
  const cluster = graph.clusters[0]!;

  it('shows what the operator reported, and who the parent is', () => {
    render(
      <AgentDetail node={hub} cluster={cluster} notes={[]} excluded={[]} onClose={() => undefined} />,
    );
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Insta Agent');
    expect(screen.getByText('Runs the Instagram presence')).toBeTruthy();
    expect(screen.getByText('posting')).toBeTruthy();
    expect(screen.getByText(/never executes/)).toBeTruthy();
    expect(screen.getByText('HWD-ZERO')).toBeTruthy();
  });

  it('names the capabilities that always need a human', () => {
    render(
      <AgentDetail node={hub} cluster={cluster} notes={[]} excluded={[]} onClose={() => undefined} />,
    );
    expect(screen.getByText('Always needs a human')).toBeTruthy();
    expect(screen.getByText('external.publish')).toBeTruthy();
  });

  it('closes on demand', () => {
    const close = vi.fn();
    render(<AgentDetail node={hub} cluster={cluster} notes={[]} excluded={[]} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalled();
  });

  it('lists the repositories the policy blocks when ZERO itself is selected', () => {
    const core = graph.nodes.find((node) => node.kind === 'core')!;
    render(
      <AgentDetail
        node={core}
        cluster={null}
        notes={['a note']}
        excluded={['Website-Building', 'Prompt-Optimizer']}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText('Never registered')).toBeTruthy();
    expect(screen.getByText('Website-Building, Prompt-Optimizer')).toBeTruthy();
  });

  it('renders nothing when nothing is selected', () => {
    const { container } = render(
      <AgentDetail node={null} cluster={null} notes={[]} excluded={[]} onClose={() => undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
