import { describe, expect, it } from 'vitest';
import { activityLabel, foldAgentRuntime } from '../src/runtime/agentActivity';
import type { OperatorApproval, OperatorEvent, OperatorEventType } from '../src/hwd/types';

let sequence = 0;
function event(
  type: OperatorEventType,
  agentId: string,
  missionId = 'M-1',
  payload: Record<string, unknown> = {},
): OperatorEvent {
  sequence += 1;
  return {
    event_id: `E-${sequence}`,
    timestamp: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    mission_id: missionId,
    agent_id: agentId,
    type,
    payload,
  };
}

function approval(executor: string): OperatorApproval {
  return {
    mission_id: 'M-1',
    task_id: 'T-1',
    gate: 'external_publish',
    reason: 'publishes to a real account',
    rationale: '',
    objective: 'post the story',
    executor,
    iteration: 1,
    payload_digest: 'sha256:abc',
  };
}

describe('what each agent is doing', () => {
  it('lights an agent only when the operator said it started', () => {
    const fold = foldAgentRuntime([event('agent.started', 'insta')]);
    expect(fold.activeAgentIds).toEqual(['insta']);
    expect(fold.erroredAgentIds).toEqual([]);
  });

  it('puts it out again when it completed', () => {
    const fold = foldAgentRuntime([
      event('agent.started', 'insta'),
      event('agent.completed', 'insta'),
    ]);
    expect(fold.activeAgentIds).toEqual([]);
  });

  it('marks an agent that failed, and stops calling it active', () => {
    const fold = foldAgentRuntime([
      event('agent.started', 'seo'),
      event('agent.error', 'seo', 'M-1', { message: 'sitemap unreachable' }),
    ]);
    expect(fold.activeAgentIds).toEqual([]);
    expect(fold.erroredAgentIds).toEqual(['seo']);
    expect(fold.agentActivity.get('seo')?.label).toBe('sitemap unreachable');
  });

  it('clears a mission’s agents when the mission itself ended', () => {
    // The per-agent completion can be lost while the phone sleeps; the mission
    // event still has to put the lights out.
    const fold = foldAgentRuntime([
      event('agent.started', 'insta', 'M-7'),
      event('agent.started', 'seo', 'M-8'),
      event('mission.completed', '', 'M-7'),
    ]);
    expect(fold.activeAgentIds).toEqual(['seo']);
  });

  it('is idempotent under the replay a reconnect produces', () => {
    const stream = [
      event('agent.started', 'insta'),
      event('agent.activity', 'insta', 'M-1', { step: 'writing caption' }),
    ];
    const once = foldAgentRuntime(stream);
    const twice = foldAgentRuntime([...stream, ...stream]);
    expect(twice.activeAgentIds).toEqual(once.activeAgentIds);
    expect(twice.agentActivity.get('insta')?.label).toBe('writing caption');
  });

  it('reads a gate as the executor being blocked, not as it running', () => {
    const fold = foldAgentRuntime(
      [event('agent.started', 'insta')],
      [approval('insta')],
      ['insta', 'seo'],
    );
    expect(fold.blockedAgentIds).toEqual(['insta']);
    expect(fold.activeAgentIds).toEqual([]);
  });

  it('ignores a gate whose executor is not an agent in the roster', () => {
    const fold = foldAgentRuntime([], [approval('some-human')], ['insta']);
    expect(fold.blockedAgentIds).toEqual([]);
  });

  it('labels activity from the operator’s own words, never from a template', () => {
    expect(activityLabel(event('agent.activity', 'x', 'M', { action: 'scraping page 3' }))).toBe(
      'scraping page 3',
    );
    expect(activityLabel(event('agent.activity', 'x', 'M', {}))).toBe('activity');
  });
});
