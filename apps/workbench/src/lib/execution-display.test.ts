import { describe, expect, it } from 'vitest';
import { projectExecutionDisplay } from './execution-display';
import type { ExecutionEvent, ExecutionRun, PlanVersion, ProposedSpecialistNode } from './types';

const specialist = (id: string, intents: string[]): ProposedSpecialistNode => ({
  id, title: id, type: 'SPECIALIST_AGENT', domain: 'engineering', objective: id, agentId: 'agent', promptDigest: 'digest',
  dependsOn: [], acceptanceCriteria: [], inputs: [], outputs: [], traceability: { intentNodeIds: intents, evidenceIds: [] },
});
const nodes = [{ id: 'intent-a' }, { id: 'intent-b' }, { id: 'unplanned-intent' }];
const plan: PlanVersion = {
  id: 'plan', graphId: 'graph', version: 1, provider: 'codex-cli', status: 'approved', contentHash: 'hash', summary: '', proposedEdges: [],
  workItems: ['develop', 'verify', 'other'].map((nodeId) => ({ id: `step:${nodeId}`, nodeId, title: nodeId, description: '', acceptanceCriteria: [], dependencies: [] })),
  proposedGraph: { proposalId: 'proposal', schemaVersion: 'v1', status: 'PROPOSED', compilerVersion: 'v1', contentDigest: 'digest', selectedDomains: [], relationships: [], nodes: [specialist('develop', ['intent-a']), specialist('verify', ['intent-a']), specialist('other', ['intent-b'])] },
};
const run: ExecutionRun = { id: 'run', graphId: 'graph', planId: 'plan', status: 'running', selectedNodeIds: ['develop', 'verify'] };
const event = (type: string, nodeId?: string, executionId = 'run'): ExecutionEvent => ({ id: `${type}:${nodeId}`, cursor: '1', type, nodeId, executionId, level: 'info', message: '', timestamp: '2026-09-12T00:00:00Z' });

describe('execution display projection', () => {
  it('maps a specialist failure to its intent and keeps excluded intents in draft', () => {
    const before = JSON.stringify({ nodes, plan, run });
    const result = projectExecutionDisplay(nodes, plan, run, [event('node.started', 'develop'), event('node.failed', 'develop'), event('execution.failed', 'develop')]);
    expect(result.proposalStatuses).toEqual({ develop: 'failed', verify: 'blocked', other: 'draft' });
    expect(result.intentStatuses).toEqual({ 'intent-a': 'failed', 'intent-b': 'draft', 'unplanned-intent': 'draft' });
    expect(JSON.stringify({ nodes, plan, run })).toBe(before);
  });

  it('requires every linked step to complete and does not turn partial selected coverage into intent completion', () => {
    expect(projectExecutionDisplay(nodes, plan, run, [event('node.completed', 'develop')]).intentStatuses['intent-a']).toBe('partial');
    expect(projectExecutionDisplay(nodes, plan, run, [event('node.completed', 'develop'), event('node.started', 'verify')]).intentStatuses['intent-a']).toBe('running');
    expect(projectExecutionDisplay(nodes, plan, { ...run, status: 'completed' }, [event('node.completed', 'develop'), event('node.completed', 'verify')]).intentStatuses['intent-a']).toBe('completed');
    const limited = projectExecutionDisplay(nodes, plan, { ...run, status: 'completed', selectedNodeIds: ['develop'] }, [event('node.completed', 'develop')]);
    expect(limited.intentStatuses['intent-a']).toBe('partial');
    expect(limited.proposalStatuses.verify).toBe('draft');
  });

  it('preserves failure across late completion and ignores events from another execution', () => {
    const result = projectExecutionDisplay(nodes, plan, { ...run, status: 'completed' }, [
      event('node.failed', 'verify'), event('node.completed', 'verify'), event('node.completed', 'develop'), event('node.failed', 'other', 'old-run'),
    ]);
    expect(result.intentStatuses['intent-a']).toBe('failed');
    expect(result.proposalStatuses.verify).toBe('failed');
    expect(result.intentStatuses['intent-b']).toBe('draft');
  });

  it('projects durable reused checkpoints, pause and cancellation without stale queued badges', () => {
    const paused = projectExecutionDisplay(nodes, plan, { ...run, status: 'paused', completedNodeIds: ['develop'] }, []);
    expect(paused.proposalStatuses).toEqual({ develop: 'completed', verify: 'paused', other: 'draft' });
    expect(paused.intentStatuses['intent-a']).toBe('paused');
    const cancelled = projectExecutionDisplay(nodes, plan, { ...run, status: 'cancelled', completedNodeIds: ['develop'] }, []);
    expect(cancelled.proposalStatuses.verify).toBe('cancelled');
    expect(cancelled.intentStatuses['intent-a']).toBe('cancelled');
    expect(projectExecutionDisplay(nodes, plan, { ...run, status: 'completed' }, []).proposalStatuses.verify).toBe('not_run');
  });

  it('uses direct step and source snapshot mappings for plans without a proposed graph', () => {
    const legacy: PlanVersion = { ...plan, proposedGraph: undefined, workItems: [
      { id: 'step:a', nodeId: 'intent-a', title: '', description: '', acceptanceCriteria: [], dependencies: [] },
      { id: 'step:b', nodeId: 'legacy-specialist', title: '', description: '', acceptanceCriteria: [], dependencies: [], sourceIntents: [{ id: 'intent-b', title: '', objective: '' }] },
    ] };
    const result = projectExecutionDisplay(nodes, legacy, { ...run, selectedNodeIds: null, completedNodeIds: ['intent-a', 'legacy-specialist'] }, []);
    expect(result.intentStatuses['intent-a']).toBe('completed');
    expect(result.intentStatuses['intent-b']).toBe('completed');
  });

  it('does not transfer runtime badges to another plan revision or graph', () => {
    expect(projectExecutionDisplay(nodes, { ...plan, id: 'replacement-plan' }, run, [event('node.failed', 'verify')])).toEqual({
      intentStatuses: { 'intent-a': 'draft', 'intent-b': 'draft', 'unplanned-intent': 'draft' }, proposalStatuses: {},
    });
    expect(projectExecutionDisplay(nodes, plan, { ...run, graphId: 'another-graph' }, []).proposalStatuses).toEqual({});
  });
});
