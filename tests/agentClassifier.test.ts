import { describe, expect, it } from 'vitest';
import {
  classifyRepository,
  summarizeClassifications,
  type RepositoryEvidence,
} from '../src/zero/agentClassifier';

function evidence(partial: Partial<RepositoryEvidence>): RepositoryEvidence {
  return {
    name: 'repo',
    cwd: '/agents/repo',
    agentInstructions: false,
    hasBin: false,
    hasEntrypoint: false,
    mcpServer: false,
    frontend: false,
    zeroRuntime: false,
    ...partial,
  };
}

describe('repository classification', () => {
  it('never classifies by name — a repo without evidence is not an agent', () => {
    const result = classifyRepository(evidence({ name: 'Meta-Agent' }));
    expect(result.classification).toBe('library');
    expect(result.callable).toBe(false);
  });

  it('recognises the ZERO runtime as ZERO, not as an agent', () => {
    const result = classifyRepository(evidence({ name: 'HWD-ZERO', zeroRuntime: true }));
    expect(result.classification).toBe('zero');
    expect(result.callable).toBe(false);
  });

  it('recognises the interface as a frontend, not as an agent', () => {
    const result = classifyRepository(evidence({ name: 'brain-interface', frontend: true }));
    expect(result.classification).toBe('interface');
    expect(result.callable).toBe(false);
  });

  it('recognises an MCP server as a tool provider', () => {
    const result = classifyRepository(evidence({ name: 'Perplexity', mcpServer: true, hasBin: true }));
    expect(result.classification).toBe('toolProvider');
    expect(result.callable).toBe(false);
  });

  it('classifies a repository with agent instructions as an agent', () => {
    const result = classifyRepository(evidence({ name: 'SEO', agentInstructions: true }));
    expect(result.classification).toBe('agent');
    expect(result.callable).toBe(true);
    expect(result.reason).toContain('agent instructions');
  });

  it('classifies a runnable workspace as an agent', () => {
    const result = classifyRepository(evidence({ name: 'Insta-Agent', hasEntrypoint: true }));
    expect(result.classification).toBe('agent');
    expect(result.callable).toBe(true);
  });

  it('a frontend that also ships agent instructions stays an agent workspace', () => {
    const result = classifyRepository(
      evidence({ name: 'Website-Building', frontend: true, agentInstructions: true }),
    );
    expect(result.classification).toBe('agent');
  });

  it('summarises what was deliberately not drawn as an agent', () => {
    const notes = summarizeClassifications([
      classifyRepository(evidence({ name: 'brain-interface', frontend: true })),
      classifyRepository(evidence({ name: 'HWD-ZERO', zeroRuntime: true })),
      classifyRepository(evidence({ name: 'SEO', agentInstructions: true })),
    ]);
    expect(notes.join(' ')).toContain('brain-interface');
    expect(notes.join(' ')).toContain('HWD-ZERO');
    expect(notes.join(' ')).not.toContain('SEO');
  });
});
