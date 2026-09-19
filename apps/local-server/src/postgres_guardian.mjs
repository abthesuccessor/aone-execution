import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Kept outside the engine process: EOF arrives even when that process is killed.
// It only controls the exact private cluster passed by its owning worker.
const [dataDirectory, expectedPidText, ownerPid, socket, ownerToken] = process.argv.slice(2);
const expectedPid = Number(expectedPidText);
if (!dataDirectory || !socket || !ownerToken || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) process.exit(1);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const postmaster = Number((await readFile(join(dataDirectory, 'postmaster.pid'), 'utf8').catch(() => '')).split('\n')[0]);
  // Never let an old guardian signal a successor cluster at the same path.
  if (postmaster && postmaster !== expectedPid) process.exit(0);
  try { process.kill(expectedPid, 'SIGINT'); } catch (error) { if (error.code !== 'ESRCH') process.exit(1); }
  const deadline = Date.now() + 15_000;
  let running = true;
  while (Date.now() < deadline) {
    try { process.kill(expectedPid, 0); } catch (error) { if (error.code === 'ESRCH') { running = false; break; } }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (running) process.exit(1); // Retain ownership metadata when shutdown is uncertain.
  // Leave shared ownership metadata for the next opener's stale-owner check.
  // Removing it here could race a successor that has already acquired the path.
  await rm(socket, { recursive: true, force: true });
  process.exit(0);
}
process.stdin.resume();
process.stdin.once('end', stop);
process.stdin.once('error', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.write('EGE_POSTGRES_GUARDIAN_READY\n');
