import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalRepository } from '../src/database.mjs';

test('trace repository enforces causal ownership, terminal history, and stable tuple pagination', () => {
  const repository = new LocalRepository(':memory:');
  const graph = repository.createGraph({ name: 'Trace repository' });
  const startedAt = '2026-08-22T00:00:00.000Z';
  const ids = [
    '00000000000000000000000000000001',
    '00000000000000000000000000000002',
    '00000000000000000000000000000003',
  ];
  for (const id of ids) repository.createTrace({
    id, graphId: graph.id, kind: 'PLAN', name: id, startedAt,
    attributes: { captureMode: 'FULL', exportMode: 'ENABLED' },
  });
  assert.equal(repository.getTrace(ids[0]).attributes.captureMode, 'REDACTED_LOCAL');
  assert.equal(repository.getTrace(ids[0]).attributes.exportMode, 'DISABLED');

  const first = repository.listGraphTraces(graph.id, { limit: 2 });
  assert.deepEqual(first.map((trace) => trace.id), [ids[2], ids[1]]);
  const second = repository.listGraphTraces(graph.id, {
    before: { startedAt: first.at(-1).startedAt, id: first.at(-1).id }, limit: 2,
  });
  assert.deepEqual(second.map((trace) => trace.id), [ids[0]]);

  const firstRoot = repository.startTraceSpan({ traceId: ids[0], name: 'ege.plan', root: true }).span;
  const secondRoot = repository.startTraceSpan({ traceId: ids[1], name: 'ege.plan', root: true }).span;
  assert.throws(() => repository.startTraceSpan({
    traceId: ids[0], parentSpanId: secondRoot.id, name: 'cross-trace',
  }), /same trace/);
  repository.endTraceSpan(firstRoot.id, { status: 'OK' });
  repository.endTrace(ids[0], { status: 'OK' });
  assert.throws(() => repository.startTraceSpan({ traceId: ids[0], name: 'late' }), /terminal trace/);

  repository.startTraceSpan({ traceId: ids[2], name: 'forgotten', root: true });
  const terminal = repository.endTrace(ids[2], { status: 'OK' });
  assert.equal(terminal.trace.status, 'ERROR');
  assert.equal(terminal.trace.attributes.telemetryIncomplete, true);
  assert.ok(repository.listTraceEvents(ids[2]).some((event) => event.type === 'span.ended' && event.telemetryIncomplete));
  repository.close();
});
