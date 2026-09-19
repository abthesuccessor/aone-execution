import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEngineeringEnvironment, engineeringPlanningGuidance, normalizeEngineeringOptions } from '../src/engineering_environment.mjs';

test('environment inspection runs only bounded allowlisted version checks, prevents toolchain downloads, and caches with explicit refresh', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-env-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="example"');
  const calls = [];
  let time = 1_700_000_000_000;
  const inspector = createEngineeringEnvironment({ environment: { PATH: '/usr/bin', HOME: root, SECRET: 'never-forward' }, clock: () => time,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'rustc') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (command === 'cargo') throw Object.assign(new Error('timeout'), { killed: true });
      return { stdout: `${command} installed-version\n`, stderr: '' };
    },
  });
  const result = await inspector.inspect(root);
  assert.equal(calls.length, 11);
  assert.equal(calls.every((call) => call.options.shell === false && call.options.timeout === 2000 && call.options.maxBuffer === 16_384), true);
  assert.equal(calls.every((call) => !('SECRET' in call.options.env) && call.options.env.GOTOOLCHAIN === 'local' && call.options.env.RUSTUP_AUTO_INSTALL === '0'), true);
  assert.equal(calls.some((call) => call.args.some((arg) => ['install', 'build', 'run', '-c'].includes(arg))), false);
  assert.deepEqual(result.missingSuggestedToolIds, ['rust', 'cargo']);
  assert.match(result.tools.find((tool) => tool.id === 'rust').detail, /not found/);
  assert.match(result.tools.find((tool) => tool.id === 'cargo').detail, /2 seconds/);
  assert.ok(result.tools.find((tool) => tool.id === 'rust').setupOptions[0].url.startsWith('https://'));
  assert.equal(result.installsPerformed, false);
  await inspector.inspect(root);
  assert.equal(calls.length, 11);
  await inspector.inspect(root, { refresh: true });
  assert.equal(calls.length, 22);
  time += 30_001;
  await inspector.inspect(root);
  assert.equal(calls.length, 33);
  await assert.rejects(inspector.inspect('relative-folder'), { code: 'WORKSPACE_REQUIRED' });
});

test('engineering profile guidance is proportional, preserves conventions, and never promises installed tools or fixed framework versions', () => {
  assert.deepEqual(normalizeEngineeringOptions(), { engineeringProfile: 'mvp', conventions: '' });
  assert.throws(() => normalizeEngineeringOptions({ engineeringProfile: 'everything' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => normalizeEngineeringOptions({ conventions: ['arbitrary'] }), { code: 'VALIDATION_ERROR' });
  const guidance = engineeringPlanningGuidance({ profile: 'poc', conventions: 'Use existing Python modules.' });
  assert.match(guidance, /smallest testable experiment/);
  assert.match(guidance, /Use existing Python modules/);
  assert.match(guidance, /Do not use a fixed seven-node template/);
  assert.match(guidance, /README, specification, AGENTS.md, project skills and setup guides/);
  assert.match(guidance, /never a fabricated passing build or unapproved automatic installation/);
});
