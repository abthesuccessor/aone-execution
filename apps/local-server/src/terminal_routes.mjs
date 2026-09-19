import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SESSIONS = 8;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ACTIVE_EXECUTIONS = new Set(['QUEUED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED']);
// Python's standard-library pty module allocates a controlling terminal without
// requiring an npm native addon or exposing a command interpolation boundary.
const PTY_BRIDGE = String.raw`
import os, pty, select, sys, signal, errno, struct, fcntl, termios
pid, master = pty.fork()
if pid == 0:
    shell = '/bin/zsh' if os.path.exists('/bin/zsh') else '/bin/sh'
    os.execv(shell, [shell, '-f', '-i', '-o', 'NO_BANG_HIST', '-o', 'NO_ZLE'] if shell.endswith('zsh') else [shell, '-i'])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))
try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 1)
        if master in readable:
            try:
                data = os.read(master, 16384)
            except OSError as error:
                if error.errno == errno.EIO: break
                raise
            if not data: break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in readable:
            data = os.read(sys.stdin.fileno(), 16384)
            if not data: break
            os.write(master, data)
finally:
    os.close(master)
    try: os.killpg(pid, signal.SIGHUP)
    except OSError: pass
    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status))
    except ChildProcessError: pass
`;

function descendantPids(rootPid) {
  try {
    const records = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024 * 1024 }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    const discovered = new Set([rootPid]);
    let changed = true;
    while (changed) { changed = false; for (const [pid, ppid] of records) if (discovered.has(ppid) && !discovered.has(pid)) { discovered.add(pid); changed = true; } }
    return [...discovered].reverse();
  } catch { return [rootPid]; }
}
function signalProcesses(pids, signal) { for (const pid of pids) { try { process.kill(pid, signal); } catch {} } }
function cleanEnvironment(environment) {
  const output = {};
  // DEVELOPER_DIR selects the active Apple toolchain. Stripping it makes the
  // shim at /usr/bin/python3 fall back to xcrun's own lookup, which on a
  // Command-Line-Tools-only Mac reports 'You have not agreed to the Xcode
  // license agreements' and exits 69 -- so the PTY never starts, and the error
  // names a tool the user never asked for. Inherit the parent's toolchain
  // selection instead; it is a path, not a credential.
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'DEVELOPER_DIR']) if (environment[key]) output[key] = environment[key];
  return { ...output, PATH: output.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', TERM: 'dumb', SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', PYTHONUNBUFFERED: '1' };
}

export function createTerminalRoutes({ repository, readJson, json, HttpError, environment = process.env, spawnImpl = spawn }) {
  const sessions = new Map();
  let closed = false;
  const fail = (status, code, message) => { throw new HttpError(status, code, message); };
  const canonicalPath = (path) => { if (!path) return null; try { return realpathSync(path); } catch { return path; } };
  const assertWorkspaceIdle = (graphId, workspacePath) => {
    const graphs = repository.listGraphs ? repository.listGraphs() : [repository.getGraph(graphId)];
    if (graphs.some((graph) => graph && (graph.id === graphId || canonicalPath(graph.workspacePath) === workspacePath) && repository.listExecutions(graph.id).some((run) => ACTIVE_EXECUTIONS.has(run.status)))) fail(409, 'TERMINAL_EXECUTION_ACTIVE', 'Stop or finish the approved execution before using the shell. Paused runs still protect their workspace.');
  };
  const snapshot = (session) => ({ id: session.id, graphId: session.graphId, workspacePath: session.workspacePath, status: session.status, startedAt: session.startedAt, endedAt: session.endedAt, exitCode: session.exitCode, signal: session.signal, error: session.error, lastSequence: session.sequence, firstSequence: session.records[0]?.sequence ?? session.sequence, output: session.records.map((record) => record.text).join(''), truncated: session.truncated });
  const publish = (session, type, data) => {
    for (const client of session.clients) {
      if (client.writableEnded || client.destroyed) { session.clients.delete(client); continue; }
      if (client.writableLength > 256 * 1024) { client.end(); session.clients.delete(client); continue; }
      client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  const record = (session, text) => {
    session.lastActivity = Date.now();
    const item = { sequence: ++session.sequence, text };
    session.records.push(item); session.outputBytes += Buffer.byteLength(text);
    while (session.outputBytes > MAX_OUTPUT_BYTES && session.records.length > 1) { session.outputBytes -= Buffer.byteLength(session.records.shift().text); session.truncated = true; }
    publish(session, 'output', item);
  };
  const stop = (session, reason = 'Stopped by user.') => {
    if (session.status !== 'running' && session.status !== 'starting') return;
    session.status = 'stopping'; session.error = reason;
    const pids = descendantPids(session.process.pid);
    session.process.stdin?.write('\x03');
    signalProcesses(pids, 'SIGTERM');
    try { process.kill(-session.process.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { signalProcesses(pids, 'SIGKILL'); try { process.kill(-session.process.pid, 'SIGKILL'); } catch {} }, 350);
    timer.unref();
    publish(session, 'state', snapshot(session));
  };
  const assertWorkspace = async (graphId) => {
    const graph = repository.getGraph(graphId);
    if (!graph) fail(404, 'GRAPH_NOT_FOUND', 'Workspace was not found.');
    if (!graph.workspacePath) fail(422, 'TERMINAL_WORKSPACE_REQUIRED', 'Bind a local project folder before opening a terminal.');
    assertWorkspaceIdle(graphId, canonicalPath(graph.workspacePath));
    let canonical;
    try { canonical = await realpath(graph.workspacePath); if (!(await stat(canonical)).isDirectory()) throw new Error(); } catch { fail(422, 'TERMINAL_WORKSPACE_UNAVAILABLE', 'The bound project folder is unavailable.'); }
    assertWorkspaceIdle(graphId, canonical);
    if (repository.getGraph(graphId)?.workspacePath !== graph.workspacePath) fail(409, 'TERMINAL_WORKSPACE_CHANGED', 'The workspace binding changed. Open the terminal again.');
    return canonical;
  };
  const assertGraphIdle = (graphId) => {
    const workspacePath = canonicalPath(repository.getGraph(graphId)?.workspacePath);
    if ([...sessions.values()].some((session) => (session.graphId === graphId || session.workspacePath === workspacePath) && ['starting', 'running', 'stopping'].includes(session.status))) fail(409, 'TERMINAL_ACTIVE', 'Stop the workspace terminal before starting or resuming an approved execution.');
  };
  const sweep = setInterval(() => { for (const session of sessions.values()) { if (Date.now() - session.lastActivity > IDLE_TIMEOUT_MS) { stop(session, 'Stopped after 30 minutes without activity.'); if (session.status === 'exited' || session.status === 'failed') { for (const client of session.clients) client.end(); sessions.delete(session.id); } } } }, 60_000);
  sweep.unref();

  async function handle({ request, response, path, method, cors }) {
    const graphMatch = path.match(/^\/api\/graphs\/([^/]+)\/terminal$/);
    const match = path.match(/^\/api\/terminals\/([^/]+)(?:\/(input|interrupt|stop|events))?$/);
    if (!graphMatch && !match) return false;
    const send = (status, value) => { json(response, status, value, cors); return true; };
    if (closed) fail(503, 'TERMINAL_SHUTTING_DOWN', 'The local server is shutting down.');
    if (graphMatch) {
      const graphId = decodeURIComponent(graphMatch[1]);
      const existing = [...sessions.values()].reverse().find((session) => session.graphId === graphId);
      if (method === 'GET') return send(200, { session: existing ? snapshot(existing) : null });
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Use POST to open a workspace terminal.');
      const workspacePath = await assertWorkspace(graphId);
      const active = [...sessions.values()].find((session) => session.graphId === graphId && ['starting', 'running', 'stopping'].includes(session.status));
      if (active) return send(200, { session: snapshot(active) });
      for (const [id, session] of sessions) if (session.status === 'exited' || session.status === 'failed') { for (const client of session.clients) client.end(); sessions.delete(id); }
      if (sessions.size >= MAX_SESSIONS) fail(429, 'TERMINAL_LIMIT', 'Stop an existing terminal before opening another.');
      assertWorkspaceIdle(graphId, workspacePath);
      const child = spawnImpl('python3', ['-u', '-c', PTY_BRIDGE], { cwd: workspacePath, env: cleanEnvironment(environment), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const session = { id: randomUUID(), graphId, workspacePath, process: child, status: 'starting', startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, error: null, records: [], sequence: 0, outputBytes: 0, truncated: false, clients: new Set(), lastActivity: Date.now() };
      sessions.set(session.id, session);
      child.on('spawn', () => { session.status = 'running'; publish(session, 'state', snapshot(session)); });
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (text) => record(session, text)); child.stderr.on('data', (text) => record(session, text));
      child.stdin.on('error', (error) => { if (session.status === 'running') { session.error = error.message; publish(session, 'state', snapshot(session)); } });
      child.on('error', (error) => { session.status = 'failed'; session.error = error.code === 'ENOENT' ? 'python3 is required to allocate a local pseudo-terminal and was not found.' : error.message; session.endedAt = new Date().toISOString(); publish(session, 'state', snapshot(session)); });
      child.on('close', (code, signal) => { session.status = session.status === 'failed' ? 'failed' : 'exited'; session.exitCode = code; session.signal = signal; session.endedAt = new Date().toISOString(); publish(session, 'state', snapshot(session)); for (const client of session.clients) client.end(); session.clients.clear(); });
      return send(201, { session: snapshot(session) });
    }
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const session = sessions.get(id);
    if (!session) fail(404, 'TERMINAL_NOT_FOUND', 'Terminal session was not found.');
    if (!action && method === 'GET') return send(200, { session: snapshot(session) });
    if (action === 'events' && method === 'GET') {
      if (session.clients.size >= 8) fail(429, 'TERMINAL_STREAM_LIMIT', 'Too many streams are attached to this terminal.');
      response.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(session))}\n\n`);
      if (['exited', 'failed'].includes(session.status)) { response.end(); return true; }
      session.clients.add(response);
      const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(': heartbeat\n\n'); }, 15_000);
      heartbeat.unref();
      response.on('close', () => { clearInterval(heartbeat); session.clients.delete(response); });
      return true;
    }
    if (action === 'stop' && method === 'POST') { stop(session); return send(200, { session: snapshot(session) }); }
    if (action === 'interrupt' && method === 'POST') { if (session.status === 'running') session.process.stdin.write('\x03'); return send(200, { session: snapshot(session) }); }
    if (action === 'input' && method === 'POST') {
      const workspacePath = await assertWorkspace(session.graphId);
      if (workspacePath !== session.workspacePath) { stop(session, 'Workspace binding changed.'); fail(409, 'TERMINAL_WORKSPACE_CHANGED', 'The workspace binding changed. Open a new terminal.'); }
      if (session.status !== 'running') fail(409, 'TERMINAL_NOT_RUNNING', 'Open a running terminal before sending input.');
      const body = await readJson(request);
      if (typeof body.input !== 'string' || !body.input.length || Buffer.byteLength(body.input) > 16384 || body.input.includes('\0')) fail(422, 'INVALID_TERMINAL_INPUT', 'Input must contain 1 to 16384 bytes and no null byte.');
      session.lastActivity = Date.now();
      session.process.stdin.write(body.input);
      return send(202, { accepted: true });
    }
    fail(405, 'METHOD_NOT_ALLOWED', 'This terminal action does not support that method.');
  }
  async function close() {
    closed = true; clearInterval(sweep);
    const waiting = [];
    for (const session of sessions.values()) {
      if (['running', 'starting'].includes(session.status)) waiting.push(new Promise((resolve) => { session.process.once('close', resolve); const timer = setTimeout(resolve, 700); timer.unref(); stop(session, 'Local server stopped.'); }));
      for (const client of session.clients) client.end();
    }
    await Promise.all(waiting); sessions.clear();
  }
  return { handle, close, assertGraphIdle };
}
