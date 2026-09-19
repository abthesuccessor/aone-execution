import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createLocalServer } from './server.mjs';

function requiredDirectory(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty filesystem path.`);
  }
  return resolve(value);
}

/**
 * Start the loopback server as an embedded desktop service.
 *
 * A desktop host can pass its per-user data directory and a packaged workbench
 * directory. The returned origin serves both UI assets and /api routes.
 */
export async function startEmbeddedLocalServer({
  dataDir,
  staticRoot,
  staticDir,
  host = '127.0.0.1',
  port = 0,
  databasePath,
  objectRoot,
  workspaceRoot,
  skillsRoot,
  maxSourceBytes,
  stepDelayMs,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  codexWorkspaceExecutor,
  allowedBrowserOrigins,
} = {}) {
  const applicationDataRoot = requiredDirectory(dataDir, 'dataDir');
  const resolvedStaticRoot = requiredDirectory(staticRoot || staticDir, 'staticRoot');
  if (staticRoot && staticDir && resolve(staticRoot) !== resolve(staticDir)) {
    throw new Error('staticRoot and staticDir cannot identify different directories.');
  }

  const paths = {
    dataDir: applicationDataRoot,
    databasePath: databasePath === ':memory:'
      ? ':memory:'
      : resolve(databasePath || join(applicationDataRoot, 'state', 'postgres')),
    objectRoot: resolve(objectRoot || join(applicationDataRoot, 'object-store')),
    workspaceRoot: resolve(workspaceRoot || join(applicationDataRoot, 'workspaces')),
    skillsRoot: resolve(skillsRoot || join(applicationDataRoot, 'skills')),
    staticRoot: resolvedStaticRoot,
  };

  await Promise.all([
    mkdir(applicationDataRoot, { recursive: true, mode: 0o700 }),
    ...(paths.databasePath === ':memory:' ? [] : [mkdir(dirname(paths.databasePath), { recursive: true, mode: 0o700 })]),
    mkdir(paths.objectRoot, { recursive: true, mode: 0o700 }),
    mkdir(paths.workspaceRoot, { recursive: true, mode: 0o700 }),
    mkdir(paths.skillsRoot, { recursive: true, mode: 0o700 }),
  ]);

  const localServer = createLocalServer({
    host,
    port,
    databasePath: paths.databasePath,
    objectRoot: paths.objectRoot,
    workspaceRoot: paths.workspaceRoot,
    skillsRoot: paths.skillsRoot,
    staticRoot: paths.staticRoot,
    ...(maxSourceBytes === undefined ? {} : { maxSourceBytes }),
    ...(stepDelayMs === undefined ? {} : { stepDelayMs }),
    environment,
    fetchImpl,
    ...(codexWorkspaceExecutor === undefined ? {} : { codexWorkspaceExecutor }),
    ...(allowedBrowserOrigins === undefined ? {} : { allowedBrowserOrigins }),
  });

  try {
    const address = await localServer.start();
    return Object.freeze({
      origin: localServer.address,
      host,
      port: address.port,
      paths: Object.freeze({ ...paths }),
      close: () => localServer.close(),
    });
  } catch (error) {
    await localServer.close().catch(() => {});
    throw error;
  }
}
