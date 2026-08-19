import { describe, expect, it } from 'vitest';
import { buildRoutingPrompt, parseDecision } from '../src/zero/router';
import type { ZeroAgent } from '../src/zero/agentRegistry';

const AGENTS: ZeroAgent[] = [
  {
    id: 'lead-scraper',
    name: 'Autonomous-Website-Lead-Scraper',
    cwd: '/agents/Autonomous-Website-Lead-Scraper',
    role: 'scout',
    capabilities: ['find companies', 'rate websites'],
    enabled: true,
    source: 'scan',
    classification: 'agent',
    classificationReason: 'ships agent instructions',
    callable: true,
    invocationMethod: 'thread/start',
  },
  {
    id: 'seo',
    name: 'SEO',
    cwd: '/agents/SEO',
    enabled: true,
    source: 'scan',
    classification: 'agent',
    classificationReason: 'runnable workspace',
    callable: true,
    invocationMethod: 'thread/start',
  },
];

describe('ZERO routing', () => {
  it('hands ZERO the real agent roster, not a hardcoded list', () => {
    const prompt = buildRoutingPrompt('Finde Firmen mit schlechten Webseiten', AGENTS);
    expect(prompt).toContain('id: lead-scraper');
    expect(prompt).toContain('capabilities: find companies, rate websites');
    expect(prompt).toContain('workspace: /agents/SEO');
    expect(prompt).toContain('Finde Firmen mit schlechten Webseiten');
  });

  it('parses a structured decision', () => {
    const decision = parseDecision(
      JSON.stringify({
        needsAgent: true,
        agentIds: ['lead-scraper'],
        task: 'Find companies with weak websites',
        reply: 'Ich übergebe das dem Lead-Scraper.',
        reason: 'capability match',
      }),
      AGENTS,
    );
    expect(decision).toMatchObject({
      agentIds: ['lead-scraper'],
      task: 'Find companies with weak websites',
    });
  });

  it('drops agent ids ZERO invented', () => {
    const decision = parseDecision(
      JSON.stringify({
        needsAgent: true,
        agentIds: ['lead-scraper', 'ghost-agent'],
        task: 't',
        reply: 'r',
        reason: 'x',
      }),
      AGENTS,
    );
    expect(decision?.agentIds).toEqual(['lead-scraper']);
  });

  it('returns no agents when ZERO answers directly', () => {
    const decision = parseDecision(
      JSON.stringify({ needsAgent: false, agentIds: ['seo'], task: '', reply: 'Guten Abend.', reason: 'small talk' }),
      AGENTS,
    );
    expect(decision?.agentIds).toEqual([]);
    expect(decision?.reply).toBe('Guten Abend.');
  });

  it('tolerates a fenced JSON answer and refuses unusable output', () => {
    const fenced = parseDecision(
      '```json\n{"needsAgent":false,"agentIds":[],"task":"","reply":"ok","reason":"y"}\n```',
      AGENTS,
    );
    expect(fenced?.reply).toBe('ok');
    expect(parseDecision('I could not decide.', AGENTS)).toBeNull();
    expect(parseDecision('', AGENTS)).toBeNull();
  });
});
