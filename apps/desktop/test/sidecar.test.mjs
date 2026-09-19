import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('packaged Node runtime starts the PostgreSQL desktop sidecar on loopback', async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-tauri-sidecar-'));
  const skillsRoot = join(temporaryRoot, 'skills');
  await mkdir(skillsRoot, { recursive: true });
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const packagedResources = join(temporaryRoot, 'packaged-sidecar');
  await cp(resolve('resources/sidecar'), packagedResources, { recursive: true, verbatimSymlinks: true });
  const bundle = join(packagedResources, 'server.mjs');
  const { readdir } = await import('node:fs/promises');
  const runtimes = (await readdir(resolve('src-tauri/binaries'))).filter((name) => name.startsWith('ege-node-'));
  const cpu = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  const runtime = runtimes.find((name) => name.startsWith(`ege-node-${cpu}-`) && (process.platform === 'darwin' ? name.endsWith('-apple-darwin') : name.includes('-linux-')));
  assert.ok(runtime, 'The packaged native runtime must exist for this CPU and OS.');
  const relocatedRuntime = join(temporaryRoot, 'ege-node');
  await copyFile(resolve('src-tauri/binaries', runtime), relocatedRuntime);
  const child = spawn(relocatedRuntime, [
    bundle,
    `--database-path=${join(temporaryRoot, 'engine-data', 'postgres')}`,
    `--object-root=${join(temporaryRoot, 'engine-data', 'object-store')}`,
    `--skills-root=${skillsRoot}`,
    `--workspace-root=${homedir()}`,
    '--browser-origin=tauri://localhost',
    '--port=0',
    '--smoke-test',
  ], {
    cwd: temporaryRoot,
    env: { ...process.env, EGE_ENABLE_WORKSPACE_WRITE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /EGE_SERVER_READY http:\/\/127\.0\.0\.1:\d+/);
  assert.match(stdout, /EGE_SIDECAR_SMOKE_PASS/);
});
