import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const processes = [];
let shuttingDown = false;
const webPort = process.env.EGE_WEB_PORT ?? '5173';
const apiPort = process.env.EGE_PORT ?? '4317';

function start(label, args) {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  child.once('error', (error) => {
    console.error(`[${label}] failed to start: ${error.message}`);
    shutdown(1);
  });

  child.once('exit', (code, signal) => {
    if (shuttingDown) return;
    if (signal) console.error(`[${label}] stopped by ${signal}`);
    else console.error(`[${label}] exited with code ${code ?? 1}`);
    shutdown(code ?? 1);
  });

  processes.push(child);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  const forceTimer = setTimeout(() => {
    for (const child of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }, 3_000);
  forceTimer.unref();

  setTimeout(() => process.exit(exitCode), 50).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('Starting the local Execution Graph workbench');
console.log(`Workbench: http://127.0.0.1:${webPort}`);
console.log(`Local API:  http://127.0.0.1:${apiPort}`);

start('local-server', ['--workspace', '@aone-execution/local-server', 'run', 'start']);
start('workbench', ['--workspace', '@aone-execution/workbench', 'run', 'dev']);
