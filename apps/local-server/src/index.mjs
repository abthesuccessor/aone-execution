import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalServer } from './server.mjs';

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  const localServer = createLocalServer({
    host: process.env.EGE_HOST || '127.0.0.1',
    port: Number(process.env.EGE_PORT || 4317),
    databasePath: process.env.EGE_DATABASE_PATH || resolve('.ege/postgres'),
    objectRoot: process.env.EGE_OBJECT_ROOT,
    skillsRoot: process.env.EGE_SKILLS_ROOT,
    workspaceRoot: process.env.EGE_WORKSPACE_ROOT || process.cwd(),
    staticRoot: process.env.EGE_STATIC_ROOT,
  });
  const address = await localServer.start();
  process.stdout.write(`Execution Graph local server listening on ${localServer.address}\n`);

  const shutdown = async () => {
    await localServer.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export { createLocalServer } from './server.mjs';
export { startEmbeddedLocalServer } from './embedded.mjs';
