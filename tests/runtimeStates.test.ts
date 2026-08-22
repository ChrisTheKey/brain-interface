import { describe, expect, it } from 'vitest';
import {
  deriveRuntimeState,
  foldMissionPhase,
  IDLE_SIGNALS,
  missionPhaseFromEvent,
  normalizeReportedState,
  RUNTIME_STATES,
  RUNTIME_STATE_VISUALS,
  type RuntimeSignals,
} from '../src/runtime/states';

const signals = (overrides: Partial<RuntimeSignals> = {}): RuntimeSignals => ({
  ...IDLE_SIGNALS,
  connection: 'open',
  ...overrides,
});

describe('the eleven runtime states', () => {
  it('declares every state the interface promises, and a visual for each', () => {
    expect(RUNTIME_STATES).toEqual([
      'IDLE',
      'LISTENING',
      'FINALIZING',
      'THINKING',
      'PLANNING',
      'AWAITING_APPROVAL',
      'EXECUTING',
      'VERIFYING',
      'SPEAKING',
      'ERROR',
      'SAFE_MODE',
    ]);
    for (const state of RUNTIME_STATES) {
      expect(RUNTIME_STATE_VISUALS[state].label.length).toBeGreaterThan(0);
      expect(RUNTIME_STATE_VISUALS[state].accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('is IDLE when nothing is happening', () => {
    expect(deriveRuntimeState(signals())).toBe('IDLE');
  });

  it('puts the kill switch above everything else', () => {
    expect(
      deriveRuntimeState(
        signals({
          safeMode: true,
          error: 'boom',
          approvalsPending: 3,
          micOpen: true,
          speaking: true,
          missionPhase: 'executing',
        }),
      ),
    ).toBe('SAFE_MODE');
  });

  it('reports an unreachable operator as an error rather than as idle', () => {
    expect(deriveRuntimeState(signals({ connection: 'unreachable' }))).toBe('ERROR');
  });

  it('demands a human as soon as one gate is genuinely open', () => {
    expect(
      deriveRuntimeState(signals({ approvalsPending: 1, missionPhase: 'executing' })),
    ).toBe('AWAITING_APPROVAL');
  });

  it('lets the microphone win over ZERO speaking — that is barge-in', () => {
    expect(deriveRuntimeState(signals({ micOpen: true, speaking: true }))).toBe('LISTENING');
  });

  it('walks a spoken turn through LISTENING → FINALIZING → THINKING → SPEAKING', () => {
    expect(deriveRuntimeState(signals({ micOpen: true }))).toBe('LISTENING');
    expect(deriveRuntimeState(signals({ finalizing: true }))).toBe('FINALIZING');
    expect(deriveRuntimeState(signals({ awaitingResponse: true }))).toBe('THINKING');
    expect(deriveRuntimeState(signals({ speaking: true }))).toBe('SPEAKING');
  });

  it('walks a mission through PLANNING → EXECUTING → VERIFYING', () => {
    expect(deriveRuntimeState(signals({ missionPhase: 'created' }))).toBe('THINKING');
    expect(deriveRuntimeState(signals({ missionPhase: 'planning' }))).toBe('PLANNING');
    expect(deriveRuntimeState(signals({ missionPhase: 'executing' }))).toBe('EXECUTING');
    expect(deriveRuntimeState(signals({ missionPhase: 'verifying' }))).toBe('VERIFYING');
    expect(deriveRuntimeState(signals({ missionPhase: 'completed' }))).toBe('IDLE');
  });

  it('adopts a state HWD-ZERO reports itself, over its own fold of the events', () => {
    expect(
      deriveRuntimeState(signals({ missionPhase: 'planning', reported: 'executing' })),
    ).toBe('EXECUTING');
  });

  it('never lets a reported state override SAFE_MODE, a gate or the microphone', () => {
    expect(deriveRuntimeState(signals({ reported: 'EXECUTING', safeMode: true }))).toBe('SAFE_MODE');
    expect(deriveRuntimeState(signals({ reported: 'EXECUTING', approvalsPending: 1 }))).toBe(
      'AWAITING_APPROVAL',
    );
    expect(deriveRuntimeState(signals({ reported: 'EXECUTING', micOpen: true }))).toBe('LISTENING');
  });

  it('ignores a reported state that is not one of ours', () => {
    expect(normalizeReportedState('DAYDREAMING')).toBeNull();
    expect(normalizeReportedState('SAFE_MODE')).toBeNull();
    expect(normalizeReportedState(' planning ')).toBe('PLANNING');
    expect(normalizeReportedState('awaiting-approval')).toBeNull();
    expect(deriveRuntimeState(signals({ reported: 'DAYDREAMING' }))).toBe('IDLE');
  });
});

describe('mission phase folding', () => {
  it('maps only the events that really describe a lifecycle', () => {
    expect(missionPhaseFromEvent({ type: 'mission.planning' })).toBe('planning');
    expect(missionPhaseFromEvent({ type: 'agent.started' })).toBe('executing');
    expect(missionPhaseFromEvent({ type: 'policy.changed' })).toBeNull();
  });

  it('takes the newest phase in the stream', () => {
    expect(
      foldMissionPhase([
        { type: 'mission.created' },
        { type: 'mission.planning' },
        { type: 'mission.executing' },
        { type: 'policy.suggested' },
        { type: 'mission.verifying' },
      ]),
    ).toBe('verifying');
    expect(foldMissionPhase([])).toBeNull();
  });
});
