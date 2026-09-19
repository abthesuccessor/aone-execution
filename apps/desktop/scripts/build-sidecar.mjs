import { copyFile, chmod, cp, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { postgresNativeRoot } from '../../local-server/src/postgres_runtime.mjs';

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopRoot, '../..');
const resourcesRoot = join(desktopRoot, 'resources', 'sidecar');
const binariesRoot = join(desktopRoot, 'src-tauri', 'binaries');
const serverBundle = join(resourcesRoot, 'server.mjs');
const hostArchitecture = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];

async function rustTargetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  if (process.env.EGE_TAURI_TARGET_TRIPLE) return process.env.EGE_TAURI_TARGET_TRIPLE;
  const { stdout } = await execFileAsync('rustc', ['-vV']);
  const host = stdout.match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) throw new Error('Unable to determine the Rust host target triple.');
  return host;
}

const targetTriple = await rustTargetTriple();
if (!hostArchitecture || !targetTriple.startsWith(`${hostArchitecture}-`) || (process.platform === 'darwin' && !targetTriple.endsWith('-apple-darwin')) || (process.platform === 'linux' && !targetTriple.includes('-linux-'))) throw new Error('Package the native PostgreSQL and Node runtimes on the target OS and CPU. Cross-target copying is unsupported.');

await Promise.all([
  mkdir(resourcesRoot, { recursive: true }),
  mkdir(binariesRoot, { recursive: true }),
]);

const bundleOptions = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire as __egeCreateRequire } from 'node:module'; const require = __egeCreateRequire(import.meta.url);",
  },
  legalComments: 'eof',
  metafile: true,
  sourcemap: false,
  // pg's optional native addon is unused; the engine uses the JS wire driver.
  // Resolve it explicitly so the package never reaches outside its resources.
  plugins: [{ name: 'pg-wire-driver-only', setup(plugin) {
    plugin.onResolve({ filter: /^pg-native$/ }, () => ({ path: 'pg-native', namespace: 'ege-unavailable-addon' }));
    plugin.onLoad({ filter: /.*/, namespace: 'ege-unavailable-addon' }, () => ({ contents: "throw new Error('pg-native is not packaged. Use the pg JavaScript driver.');", loader: 'js' }));
  } }],
};
const result = await build({ ...bundleOptions, entryPoints: [join(desktopRoot, 'src', 'sidecar.mjs')], outfile: serverBundle });
const workerResult = await build({ ...bundleOptions, entryPoints: [join(repositoryRoot, 'apps/local-server/src/postgres_worker.mjs')], outfile: join(resourcesRoot, 'postgres-worker.mjs') });
await build({ ...bundleOptions, entryPoints: [join(repositoryRoot, 'apps/local-server/src/postgres_guardian.mjs')], outfile: join(resourcesRoot, 'postgres-guardian.mjs') });
const nativeDestination = join(resourcesRoot, 'postgres');
await rm(nativeDestination, { recursive: true, force: true });
await cp(postgresNativeRoot(), nativeDestination, { recursive: true, dereference: false, verbatimSymlinks: true });
async function verifyNativeLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const resolved = await realpath(path);
      const contained = relative(nativeDestination, resolved);
      if (isAbsolute(target) || contained.startsWith('..') || isAbsolute(contained)) throw new Error(`PostgreSQL resource link escapes its packaged directory: ${path}`);
    } else if (entry.isDirectory()) await verifyNativeLinks(path);
  }
}
await verifyNativeLinks(nativeDestination);
await cp(join(repositoryRoot, 'third_party/postgresql'), join(resourcesRoot, 'notices/postgresql'), { recursive: true });
await cp(join(repositoryRoot, 'third_party/caveman'), join(resourcesRoot, 'notices/caveman'), { recursive: true });

const allowedExternalImports = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const unsafeExternalImports = [...Object.values(result.metafile.outputs), ...Object.values(workerResult.metafile.outputs)]
  .flatMap((output) => output.imports)
  .filter((item) => item.external && !allowedExternalImports.has(item.path));
if (unsafeExternalImports.length > 0) {
  throw new Error(`Desktop sidecar has unpackaged runtime imports: ${unsafeExternalImports.map((item) => item.path).join(', ')}`);
}

// Preserve the licenses of packages actually included by the sidecar bundler.
const packageNames = [...new Set([...Object.keys(result.metafile.inputs), ...Object.keys(workerResult.metafile.inputs)]
  .map((input) => input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1])
  .filter(Boolean))].sort();
const notices = ['Third-party software included in the local engineering engine.\n'];
for (const name of packageNames) {
  const root = join(repositoryRoot, 'node_modules', name);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const licenseFiles = (await readdir(root)).filter((file) => /^(license|licence|copying|notice)(\.|$)/i.test(file));
  notices.push(`${name}@${manifest.version}\nLicense: ${manifest.license || 'See package notices'}`);
  for (const file of licenseFiles) {
    try { notices.push(`${file}\n${await readFile(join(root, file), 'utf8')}`); }
    catch (error) { if (error.code !== 'EISDIR') throw error; }
  }
}
for (const file of ['LICENSE', 'LICENSING.md', 'PROVENANCE.json']) notices.push(`Caveman MIT skill integration — ${file}\n${await readFile(join(repositoryRoot, 'third_party/caveman', file), 'utf8')}`);
const nativePackage = join(repositoryRoot, 'node_modules', '@embedded-postgres', `${process.platform}-${process.arch}`);
const nativeManifest = JSON.parse(await readFile(join(nativePackage, 'package.json'), 'utf8'));
notices.push(`@embedded-postgres/${process.platform}-${process.arch}@${nativeManifest.version}\nDistribution wrapper license: ${nativeManifest.license}. Native dependency license inventory must be reviewed before redistribution.\n${await readFile(join(repositoryRoot, 'node_modules/embedded-postgres/LICENSE.md'), 'utf8')}`);
await writeFile(join(resourcesRoot, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n--------------------\n\n'));

await copyFile(
  join(repositoryRoot, 'apps', 'local-server', 'src', 'plan-output.schema.json'),
  join(resourcesRoot, 'plan-output.schema.json'),
);

const extension = process.platform === 'win32' ? '.exe' : '';
const sidecarRuntime = join(binariesRoot, `ege-node-${targetTriple}${extension}`);
await copyFile(process.execPath, sidecarRuntime);
if (process.platform !== 'win32') await chmod(sidecarRuntime, 0o755);

process.stdout.write(`Prepared Tauri Node sidecar for ${targetTriple}: ${sidecarRuntime}\n`);
process.stdout.write(`Bundled local engine: ${serverBundle}\n`);
