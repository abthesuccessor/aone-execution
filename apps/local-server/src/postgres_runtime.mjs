import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const execute = promisify(execFile);
export const POSTGRES_PACKAGE_VERSION = '18.4.0-beta.17';
export const POSTGRES_VERSION = '18.4';
const require = createRequire(import.meta.url);
export function postgresNativeRoot() {
  if (process.env.EGE_POSTGRES_NATIVE_ROOT) return resolve(process.env.EGE_POSTGRES_NATIVE_ROOT);
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const entry = require.resolve(`@embedded-postgres/${platform}-${process.arch}`);
  return resolve(dirname(entry), '../native');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }

export async function openNativePostgres(options = {}) {
  if (process.platform === 'win32') throw new Error('The private native PostgreSQL socket runtime currently supports macOS and Linux. Windows packaging is not yet qualified.');
  if (process.getuid?.() === 0) throw new Error('Native PostgreSQL must run as a non-root user. No operating-system user is created automatically.');
  const nativeRoot = postgresNativeRoot();
  const ephemeral = !options.location || options.location === ':memory:';
  const root = ephemeral ? await mkdtemp(join(tmpdir(), 'ege-pg-')) : resolve(options.location);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lock = join(root, 'owner.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readFile(join(lock, 'pid'), 'utf8').catch(() => '');
    if (!/^\d+$/.test(owner) || alive(Number(owner))) throw Object.assign(new Error('This PostgreSQL data directory already has an owner. Close the other app before opening it.'), { code: 'STORAGE_ALREADY_OPEN' });
    const oldPostmaster = Number((await readFile(join(root, 'data', 'postmaster.pid'), 'utf8').catch(() => '')).split('\n')[0]);
    if (oldPostmaster > 0 && alive(oldPostmaster)) throw Object.assign(new Error('The previous private PostgreSQL instance is still stopping. Wait for its guardian to finish before reopening.'), { code: 'STORAGE_RECOVERY_PENDING' });
    await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 });
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  const ownerToken = randomBytes(24).toString('hex');
  await writeFile(join(lock, 'token'), ownerToken, { mode: 0o600 });
  const binaries = Object.fromEntries(['postgres', 'initdb', 'pg_ctl'].map((name) => [name, join(nativeRoot, 'bin', name)]));
  const data = join(root, 'data');
  const credentialsPath = join(root, 'connection.json');
  const runtimePath = join(root, 'runtime.json');
  const socket = await mkdtemp(join('/tmp', 'ege-pg-socket-'));
  await chmod(socket, 0o700);
  let child; let guardian; let client; let log = ''; let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await client?.end().catch(() => {});
    if (child && child.exitCode === null) {
      await execute(binaries.pg_ctl, ['-D', data, '-m', 'fast', '-w', '-t', '10', 'stop'], { timeout: 15_000 }).catch(() => { try { child.kill('SIGINT'); } catch {} });
      if (child.exitCode === null) await new Promise((done) => { const timer = setTimeout(done, 2000); child.once('exit', () => { clearTimeout(timer); done(); }); });
      if (child.exitCode === null) throw Object.assign(new Error('PostgreSQL did not confirm shutdown; its data-directory lock is retained.'), { code: 'STORAGE_STOP_FAILED' });
    }
    guardian?.stdin.end();
    await rm(socket, { recursive: true, force: true });
    await rm(runtimePath, { force: true });
    await rm(lock, { recursive: true, force: true });
    if (ephemeral) await rm(root, { recursive: true, force: true });
  };
  try {
    // 30s, not 5s: this is the first execution of a ~19 MB universal Mach-O
    // binary that was just copied into place by the installer, so macOS
    // validates and pages in the whole image before main() runs. Measured cold
    // on an M-series Mac that costs 3.2-3.4s with nothing else running, which
    // left a 5s budget almost no headroom -- and it is spent on first launch
    // after install, when the machine is busiest. A genuinely stuck binary
    // still fails, just not a merely cold one.
    const version = (await execute(binaries.postgres, ['--version'], { timeout: 30000 })).stdout.trim();
    if (!version.endsWith(` ${POSTGRES_VERSION}`)) throw new Error(`Expected pinned native PostgreSQL ${POSTGRES_VERSION}; found ${version}.`);
    let credentials;
    try { credentials = JSON.parse(await readFile(credentialsPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (await stat(join(data, 'PG_VERSION')).catch(() => null)) throw new Error('Existing PostgreSQL cluster has no owned credential record. Restore its configuration; it will not be overwritten.');
      credentials = { user: 'ege_owner', password: randomBytes(32).toString('base64url'), database: 'postgres' };
      await writeFile(credentialsPath, JSON.stringify(credentials), { flag: 'wx', mode: 0o600 });
    }
    await chmod(credentialsPath, 0o600);
    const initialized = await stat(join(data, 'PG_VERSION')).catch(() => null);
    if (!initialized) {
      const passwordFile = join(root, 'init-password');
      await writeFile(passwordFile, `${credentials.password}\n`, { mode: 0o600 });
      try { await execute(binaries.initdb, ['-D', data, '-U', credentials.user, '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C'], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }); }
      finally { await rm(passwordFile, { force: true }); }
    } else if ((await readFile(join(data, 'PG_VERSION'), 'utf8')).trim() !== '18') throw new Error('PostgreSQL major version differs. An explicit pg_upgrade/export migration is required; existing data is preserved.');
    child = spawn(binaries.postgres, ['-D', data, '-h', '', '-k', socket, '-p', '5432', '-c', 'unix_socket_permissions=0700', '-c', 'max_connections=20', '-c', 'shared_buffers=32MB', '-c', 'fsync=on', '-c', 'synchronous_commit=on', '-c', 'statement_timeout=15000', '-c', 'lock_timeout=5000', '-c', 'idle_in_transaction_session_timeout=30000'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const guardianPath = process.env.EGE_POSTGRES_GUARDIAN_PATH || fileURLToPath(new URL('./postgres_guardian.mjs', import.meta.url));
    guardian = spawn(process.execPath, [guardianPath, data, String(child.pid), String(process.pid), socket, ownerToken], { stdio: ['pipe', 'pipe', 'ignore'] });
    guardian.stdin.on('error', () => {});
    guardian.on('error', (error) => { log = `${log}\nGuardian failure: ${error.message}`; try { child.kill('SIGINT'); } catch {} });
    await new Promise((ready, reject) => {
      const timer = setTimeout(() => reject(new Error('PostgreSQL shutdown guardian did not become ready.')), 5000);
      const finish = (error) => { clearTimeout(timer); guardian.removeListener('exit', failed); error ? reject(error) : ready(); };
      const failed = () => finish(new Error('PostgreSQL shutdown guardian exited before readiness.'));
      guardian.once('exit', failed);
      guardian.once('error', finish);
      guardian.stdout.once('data', (bytes) => finish(bytes.toString().trim() === 'EGE_POSTGRES_GUARDIAN_READY' ? null : new Error('PostgreSQL shutdown guardian returned an invalid handshake.')));
    });
    child.stderr.on('data', (chunk) => { log = (log + chunk.toString()).slice(-16_384); });
    let spawnError; child.on('error', (error) => { spawnError = error; });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Native PostgreSQL exited during startup: ${log}`);
      const candidate = new pg.Client({ ...credentials, host: socket, port: 5432, connectionTimeoutMillis: 1000, application_name: 'ege-local-engine' });
      candidate.on('error', () => {});
      try { await candidate.connect(); client = candidate; break; } catch { await candidate.end().catch(() => {}); }
      await new Promise((done) => setTimeout(done, 75));
    }
    if (!client) throw new Error(`Native PostgreSQL readiness timed out: ${log}`);
    // Keep int8 counters compatible with the existing JSON event cursor contract.
    pg.types.setTypeParser(20, (value) => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error('PostgreSQL integer exceeds the JSON safe integer range.'); return number; });
    const { rows } = await client.query('SELECT version() AS version, pg_backend_pid() AS backend_pid');
    const info = { engine: 'postgresql', mode: 'native-embedded', version: POSTGRES_VERSION, packageVersion: POSTGRES_PACKAGE_VERSION, dataDirectory: root, socketDirectory: socket, port: 5432, database: credentials.database, user: credentials.user, pid: child.pid, backendPid: rows[0].backend_pid, ephemeral, vector: { available: false, reason: 'pgvector is not installed in the pinned native distribution.' } };
    await writeFile(runtimePath, JSON.stringify(info), { mode: 0o600 });
    return { client, stop, info };
  } catch (error) { await stop().catch(() => {}); throw error; }
}
