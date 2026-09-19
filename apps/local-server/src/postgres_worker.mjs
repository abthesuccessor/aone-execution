import { workerData } from 'node:worker_threads';
import { openNativePostgres } from './postgres_runtime.mjs';

const { port } = workerData;
let runtime;
let queue = Promise.resolve();
port.on('message', (message) => {
  queue = queue.then(async () => {
    let envelope;
    try {
      let result;
      if (message.type === 'open') { runtime = await openNativePostgres(message.options); result = runtime.info; }
      else if (message.type === 'close') { await runtime?.stop(); result = null; }
      else if (message.type === 'query') {
        if (!runtime) throw new Error('PostgreSQL is not initialized.');
        const response = await runtime.client.query(message.text, message.values);
        const last = Array.isArray(response) ? response.at(-1) : response;
        result = { rows: last?.rows ?? [], rowCount: last?.rowCount ?? 0 };
      } else throw new Error('Unknown PostgreSQL worker operation.');
      envelope = { result };
    } catch (error) { envelope = { error: { name: error.name, message: error.message, code: error.code, detail: error.detail, constraint: error.constraint } }; }
    port.postMessage(envelope);
    Atomics.store(message.gate, 0, 1); Atomics.notify(message.gate, 0);
    if (message.type === 'close') port.close();
  });
});
port.on('close', () => { void runtime?.stop(); });
