import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerminalRoutes } from '../src/terminal_routes.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ege-terminal-'));
  const runs = new Map();
  let workspacePath = root;
  const graph = (id) => id === 'graph-test' ? { id, workspacePath } : id === 'graph-alias' ? { id, workspacePath: `${root}/.` } : null;
  const repository = { getGraph: graph, listGraphs: () => [graph('graph-test'), graph('graph-alias')], listExecutions: (id) => runs.get(id) ?? [] };
  class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const terminal = createTerminalRoutes({ repository, HttpError, readJson: async (request) => request.body, json: (response, status, body) => Object.assign(response, { status, body }) });
  context.after(async () => { await terminal.close(); await rm(root, { recursive: true, force: true }); });
  const call = async (method, path, body) => { const response = {}; assert.equal(await terminal.handle({ request: { body }, response, path, method, cors: {} }), true); return response.body; };
  return { root, terminal, call, setRuns: (value, id = 'graph-test') => { runs.set(id, value); }, setWorkspace: (value) => { workspacePath = value; } };
}
async function eventually(read, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let result;
  while (Date.now() < deadline) { result = await read(); if (predicate(result)) return result; await new Promise((resolve) => setTimeout(resolve, 35)); }
  assert.fail(`Condition did not become true: ${JSON.stringify(result)}`);
}

test('terminal allocates an interactive PTY in bound workspace, supports stdin and Ctrl+C, and exits honestly', async (context) => {
  const { call, root, terminal } = await fixture(context);
  const { session } = await call('POST', '/api/graphs/graph-test/terminal', {});
  const read = async () => (await call('GET', `/api/terminals/${session.id}`)).session;
  await eventually(read, (value) => value.status === 'running');
  assert.throws(() => terminal.assertGraphIdle('graph-test'), { code: 'TERMINAL_ACTIVE' });
  assert.throws(() => terminal.assertGraphIdle('graph-alias'), { code: 'TERMINAL_ACTIVE' });
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'pwd\n' });
  await eventually(read, (value) => value.output.includes(root));
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'printf "PTY_%s\\n" "READY"\n' });
  await eventually(read, (value) => value.output.includes('PTY_READY'));
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'sleep 30\n' });
  await eventually(read, (value) => value.output.includes('sleep 30'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call('POST', `/api/terminals/${session.id}/interrupt`, {});
  await eventually(read, (value) => value.output.includes('^C'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'printf "INTERRUPT_%s\\n" "DONE"\n' });
  await eventually(read, (value) => value.output.includes('INTERRUPT_DONE'));
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'exit 7\n' });
  const exited = await eventually(read, (value) => value.status === 'exited');
  assert.equal(exited.exitCode, 7);
  assert.doesNotThrow(() => terminal.assertGraphIdle('graph-test'));
});

test('terminal refuses unbound folders and active or paused approved executions', async (context) => {
  const { call, setWorkspace, setRuns, root } = await fixture(context);
  setWorkspace(null);
  await assert.rejects(call('POST', '/api/graphs/graph-test/terminal', {}), { code: 'TERMINAL_WORKSPACE_REQUIRED' });
  setWorkspace(root);
  for (const status of ['QUEUED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED']) {
    setRuns([{ status }]);
    await assert.rejects(call('POST', '/api/graphs/graph-test/terminal', {}), { code: 'TERMINAL_EXECUTION_ACTIVE' });
  }
  setRuns([]);
  const { session } = await call('POST', '/api/graphs/graph-test/terminal', {});
  setRuns([{ status: 'RUNNING' }]);
  await assert.rejects(call('POST', `/api/terminals/${session.id}/input`, { input: 'echo blocked\n' }), { code: 'TERMINAL_EXECUTION_ACTIVE' });
  await call('POST', `/api/terminals/${session.id}/stop`, {});
});

test('terminal stop disposes background descendants', async (context) => {
  const { call, terminal } = await fixture(context);
  const { session } = await call('POST', '/api/graphs/graph-test/terminal', {});
  const read = async () => (await call('GET', `/api/terminals/${session.id}`)).session;
  await eventually(read, (value) => value.status === 'running');
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'sleep 60 & printf "BACKGROUND_PID=%s\\n" "$!"\n' });
  const output = await eventually(read, (value) => /BACKGROUND_PID=\d+/.test(value.output));
  const pid = Number(output.output.match(/BACKGROUND_PID=(\d+)/)[1]);
  await call('POST', `/api/terminals/${session.id}/stop`, {});
  await eventually(read, (value) => value.status === 'exited');
  await eventually(async () => { try { process.kill(pid, 0); return true; } catch { return false; } }, (alive) => !alive);
  assert.doesNotThrow(() => terminal.assertGraphIdle('graph-test'));
});

test('terminal shares canonical workspace execution locks and deduplicates simultaneous opens', async (context) => {
  const { call, setRuns } = await fixture(context);
  setRuns([{ status: 'PAUSED' }], 'graph-alias');
  await assert.rejects(call('POST', '/api/graphs/graph-test/terminal', {}), { code: 'TERMINAL_EXECUTION_ACTIVE' });
  setRuns([], 'graph-alias');
  const [left, right] = await Promise.all([call('POST', '/api/graphs/graph-test/terminal', {}), call('POST', '/api/graphs/graph-test/terminal', {})]);
  assert.equal(left.session.id, right.session.id);
});

test('terminal trims a busy shell to the latest bounded output with an explicit truncation flag', async (context) => {
  const { call } = await fixture(context);
  const { session } = await call('POST', '/api/graphs/graph-test/terminal', {});
  const read = async () => (await call('GET', `/api/terminals/${session.id}`)).session;
  await eventually(read, (value) => value.status === 'running');
  await call('POST', `/api/terminals/${session.id}/input`, { input: 'python3 -c \'print("x"*1200000);print("OUTPUT_DONE")\'\n' });
  const output = await eventually(read, (value) => value.truncated && value.output.includes('\r\nOUTPUT_DONE\r\n'));
  assert.ok(Buffer.byteLength(output.output) <= 1024 * 1024);
  assert.ok(output.firstSequence > 1);
});
