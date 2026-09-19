import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startEmbeddedLocalServer } from '../src/index.mjs';

function rawRequest({ port, path, hostHeader }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: hostHeader },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('embedded server serves a secured same-origin SPA and preserves the API boundary', async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-embedded-server-'));
  const dataDir = join(temporaryRoot, 'Application Support', 'Execution Graph');
  const staticRoot = join(temporaryRoot, 'workbench-dist');
  const outsideRoot = join(temporaryRoot, 'outside');
  await mkdir(join(staticRoot, 'assets'), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><script type="module" src="/assets/app-a1b2c3d4.js"></script><main>Desktop workbench</main>');
  await writeFile(join(staticRoot, 'assets', 'app-a1b2c3d4.js'), 'globalThis.__desktopWorkbench = true;\n');
  await writeFile(join(staticRoot, 'assets', 'app-a1b2c3d4.css'), 'body { color: CanvasText; }\n');
  await writeFile(join(outsideRoot, 'secret.txt'), 'must not be served\n');
  await symlink(join(outsideRoot, 'secret.txt'), join(staticRoot, 'assets', 'leak.txt'));

  const embedded = await startEmbeddedLocalServer({
    dataDir,
    staticRoot,
    port: 0,
    stepDelayMs: 1,
  });
  context.after(async () => {
    await embedded.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  assert.equal(embedded.host, '127.0.0.1');
  assert.ok(embedded.port > 0);
  assert.equal(embedded.origin, `http://127.0.0.1:${embedded.port}`);
  assert.equal(embedded.paths.dataDir, dataDir);
  assert.equal(embedded.paths.staticRoot, staticRoot);

  const page = await fetch(`${embedded.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /Desktop workbench/);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval|https:|http:/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');

  const script = await fetch(`${embedded.origin}/assets/app-a1b2c3d4.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.equal(script.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await script.text(), /desktopWorkbench/);

  const cssHead = await fetch(`${embedded.origin}/assets/app-a1b2c3d4.css`, { method: 'HEAD' });
  assert.equal(cssHead.status, 200);
  assert.match(cssHead.headers.get('content-type'), /^text\/css/);
  assert.equal(await cssHead.text(), '');

  const spaRoute = await fetch(`${embedded.origin}/graphs/example/plan`);
  assert.equal(spaRoute.status, 200);
  assert.match(await spaRoute.text(), /Desktop workbench/);

  const absentAsset = await fetch(`${embedded.origin}/assets/missing.js`);
  assert.equal(absentAsset.status, 404);
  const absentAssetBody = await absentAsset.text();
  assert.equal(JSON.parse(absentAssetBody).error.code, 'STATIC_ASSET_NOT_FOUND');
  assert.doesNotMatch(absentAssetBody, new RegExp(temporaryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const traversal = await rawRequest({
    port: embedded.port,
    path: '/%2e%2e/secret.txt',
    hostHeader: `127.0.0.1:${embedded.port}`,
  });
  assert.equal(traversal.status, 403);
  assert.equal(JSON.parse(traversal.body).error.code, 'PATH_TRAVERSAL_REJECTED');
  assert.doesNotMatch(traversal.body, /must not be served/);
  assert.doesNotMatch(traversal.body, new RegExp(temporaryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const escapedSymlink = await fetch(`${embedded.origin}/assets/leak.txt`);
  assert.equal(escapedSymlink.status, 403);
  assert.equal((await escapedSymlink.json()).error.code, 'STATIC_PATH_OUTSIDE_ROOT');

  const hostileHost = await rawRequest({
    port: embedded.port,
    path: '/',
    hostHeader: 'attacker.example',
  });
  assert.equal(hostileHost.status, 403);
  assert.equal(JSON.parse(hostileHost.body).error.code, 'HOST_REJECTED');

  const health = await fetch(`${embedded.origin}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.match(health.headers.get('content-security-policy'), /default-src 'none'/);

  const graphResponse = await fetch(`${embedded.origin}/api/graphs`, {
    method: 'POST',
    headers: {
      Origin: embedded.origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'Desktop workspace' }),
  });
  assert.equal(graphResponse.status, 201);
  assert.equal((await graphResponse.json()).graph.name, 'Desktop workspace');
});

test('embedded server creates overridable application data roots', async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-embedded-paths-'));
  const staticRoot = join(temporaryRoot, 'static');
  const customRoot = join(temporaryRoot, 'custom');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Execution Graph</title>');

  const embedded = await startEmbeddedLocalServer({
    dataDir: join(temporaryRoot, 'app-data'),
    staticDir: staticRoot,
    databasePath: join(customRoot, 'database', 'desktop.db'),
    objectRoot: join(customRoot, 'objects'),
    workspaceRoot: join(customRoot, 'workspaces'),
    skillsRoot: join(customRoot, 'skills'),
  });
  context.after(async () => {
    await embedded.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  assert.equal(embedded.paths.databasePath, join(customRoot, 'database', 'desktop.db'));
  assert.equal(embedded.paths.objectRoot, join(customRoot, 'objects'));
  assert.equal(embedded.paths.workspaceRoot, join(customRoot, 'workspaces'));
  assert.equal(embedded.paths.skillsRoot, join(customRoot, 'skills'));
  assert.equal((await fetch(`${embedded.origin}/`)).status, 200);
  await Promise.all([embedded.close(), embedded.close()]);
});
