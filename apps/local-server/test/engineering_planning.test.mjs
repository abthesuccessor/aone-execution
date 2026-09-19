import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINEERING_PLAN_STAGES, runEngineeringPlanningStages } from '../src/engineering_planning.mjs';

test('Request plan LangGraph stages capture before the single planner request and validate before persistence', async () => {
  const calls = [];
  let captured = null;
  let proposal = null;
  const result = await runEngineeringPlanningStages({
    capture_context: async () => { calls.push('capture'); captured = { profile: 'poc', workspace: 'pinned' }; },
    propose_plan: async () => { assert.equal(captured.workspace, 'pinned'); calls.push('model'); proposal = { nodes: ['implementation'] }; },
    validate_plan: async () => { assert.equal(proposal.nodes.length, 1); calls.push('validate'); },
  });
  assert.deepEqual(calls, ['capture', 'model', 'validate']);
  assert.deepEqual(result.completedStages, [...ENGINEERING_PLAN_STAGES]);
  calls.push('persist-awaiting-review');
  assert.equal(calls.filter((call) => call === 'model').length, 1);
});

test('failed context capture stops the graph before any model call or validation', async () => {
  let invoked = false;
  await assert.rejects(runEngineeringPlanningStages({
    capture_context: async () => { throw Object.assign(new Error('Workspace is unavailable.'), { code: 'WORKSPACE_REQUIRED' }); },
    propose_plan: async () => { invoked = true; },
    validate_plan: async () => { invoked = true; },
  }), { code: 'WORKSPACE_REQUIRED' });
  assert.equal(invoked, false);
});
