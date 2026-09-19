import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
if (args[0] !== '--data-dir' || !args[1]) throw new Error('Usage: storage:psql -- --data-dir POSTGRES_DIRECTORY [-- psql arguments]');
const directory = resolve(process.env.INIT_CWD || process.cwd(), args[1]);
const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
const credentials = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
try { process.kill(runtime.pid, 0); } catch { throw new Error('The private PostgreSQL cluster is not running. Open its owning application first.'); }
const candidates = process.env.EGE_PSQL_PATH ? [process.env.EGE_PSQL_PATH] : ['psql', '/opt/homebrew/opt/libpq/bin/psql', '/usr/local/opt/libpq/bin/psql'];
let binary = candidates[0];
for (const candidate of candidates.slice(1)) { try { await access(candidate, constants.X_OK); binary = candidate; break; } catch {} }
const temporary = await mkdtemp(join(tmpdir(), 'ege-psql-'));
await chmod(temporary, 0o700);
const passfile = join(temporary, 'pgpass');
const escape = (value) => String(value).replaceAll('\\', '\\\\').replaceAll(':', '\\:');
await writeFile(passfile, `*:${runtime.port}:${escape(credentials.database)}:${escape(credentials.user)}:${escape(credentials.password)}\n`, { mode: 0o600 });
try {
  const { PGPASSWORD, PGSERVICE, PGSERVICEFILE, ...environment } = process.env;
  const child = spawn(binary, ['-h', runtime.socketDirectory, '-p', String(runtime.port), '-U', credentials.user, '-d', credentials.database, ...args.slice(args[2] === '--' ? 3 : 2)], { stdio: 'inherit', env: { ...environment, PGPASSFILE: passfile } });
  process.exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code) => done(code ?? 1)); });
} finally { await rm(temporary, { recursive: true, force: true }); }
