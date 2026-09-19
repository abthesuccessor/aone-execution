import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createLocalServer } from '../../local-server/src/server.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundledWorker = fileURLToPath(new URL('./postgres-worker.mjs', import.meta.url));
if (existsSync(bundledWorker)) {
  process.env.EGE_POSTGRES_WORKER_PATH = bundledWorker;
  process.env.EGE_POSTGRES_GUARDIAN_PATH = fileURLToPath(new URL('./postgres-guardian.mjs', import.meta.url));
  process.env.EGE_POSTGRES_NATIVE_ROOT = fileURLToPath(new URL('./postgres', import.meta.url));
}

function argumentsByName(argv) {
  const values = new Map();
  for (const argument of argv) {
    if (!argument.startsWith('--')) continue;
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const value = separator === -1 ? 'true' : argument.slice(separator + 1);
    const existing = values.get(name) ?? [];
    existing.push(value);
    values.set(name, existing);
  }
  return values;
}

function requiredAbsolutePath(argumentsMap, name) {
  const value = argumentsMap.get(name)?.at(-1);
  if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path.`);
  return resolve(value);
}

function integerArgument(argumentsMap, name, fallback) {
  const value = argumentsMap.get(name)?.at(-1);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`--${name} must be an integer from 0 to 65535.`);
  }
  return parsed;
}

const commandArguments = argumentsByName(process.argv.slice(2));
const databasePath = requiredAbsolutePath(commandArguments, 'database-path');
const objectRoot = requiredAbsolutePath(commandArguments, 'object-root');
const skillsRoot = requiredAbsolutePath(commandArguments, 'skills-root');
const workspaceRoot = requiredAbsolutePath(commandArguments, 'workspace-root');
const browserOrigins = commandArguments.get('browser-origin') ?? [];
const smokeTest = commandArguments.has('smoke-test');

await Promise.all([
  mkdir(dirname(databasePath), { recursive: true, mode: 0o700 }),
  mkdir(objectRoot, { recursive: true, mode: 0o700 }),
]);

const localServer = createLocalServer({
  host: '127.0.0.1',
  port: integerArgument(commandArguments, 'port', 0),
  databasePath,
  objectRoot,
  skillsRoot,
  workspaceRoot,
  allowedBrowserOrigins: browserOrigins,
  environment: process.env,
});

let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await localServer.close().catch(() => {});
  process.exit(exitCode);
}

process.once('SIGINT', () => { void stop(0); });
process.once('SIGTERM', () => { void stop(0); });

try {
  await localServer.start();
  process.stdout.write(`EGE_SERVER_READY ${localServer.address}\n`);
  if (smokeTest) {
    const response = await fetch(`${localServer.address}/api/health`);
    const health = await response.json();
    if (!response.ok || health.status !== 'ok' || health.storage !== 'postgresql' || health.auth !== 'none') {
      throw new Error(`Local API smoke check returned HTTP ${response.status}.`);
    }
    process.stdout.write(`EGE_SIDECAR_SMOKE_PASS ${localServer.address}\n`);
    await stop(0);
  }
} catch (error) {
  process.stderr.write(`EGE_SERVER_FATAL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  await stop(1);
}
