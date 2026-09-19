import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import { existsSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The application transaction callbacks are deliberately synchronous. One worker
// owns one pg client, so BEGIN / statements / COMMIT always use one connection.
// This is a native PostgreSQL protocol adapter, not a SQLite SQL translator.
export function postgresParameters(sql) {
  let output = ''; let quote = null; let index = 0;
  for (let offset = 0; offset < sql.length; offset += 1) {
    const char = sql[offset];
    if (quote) {
      output += char;
      if (char === quote) { if (sql[offset + 1] === quote) output += sql[++offset]; else quote = null; }
    } else if (char === "'" || char === '"') { quote = char; output += char; }
    else output += char === '?' ? `$${++index}` : char;
  }
  return output;
}

export class PostgresDatabaseSync {
  constructor(location = ':memory:') {
    const options = typeof location === 'object' ? { ...location } : { location };
    if (typeof options.location === 'string' && options.location !== ':memory:' && existsSync(options.location)) {
      let header; let descriptor;
      try { descriptor = openSync(options.location, 'r'); const bytes = Buffer.alloc(16); readSync(descriptor, bytes, 0, 16, 0); header = bytes.toString(); } catch (error) { if (error.code !== 'EISDIR') throw error; }
      finally { if (descriptor !== undefined) closeSync(descriptor); }
      if (header === 'SQLite format 3\0') throw Object.assign(new Error('A legacy SQLite database is present. Import it explicitly into a new PostgreSQL directory with storage:import-sqlite; the original is never modified.'), { code: 'LEGACY_SQLITE_IMPORT_REQUIRED' });
    }
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.closed = false;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    const workerUrl = process.env.EGE_POSTGRES_WORKER_PATH ? pathToFileURL(resolve(process.env.EGE_POSTGRES_WORKER_PATH)) : new URL('./postgres_worker.mjs', import.meta.url);
    this.worker = new Worker(workerUrl, { workerData: { port: port2 }, transferList: [port2], execArgv: [] });
    this.worker.on('error', () => {});
    try { this.info = this.request('open', { options }, 90_000); }
    catch (error) { this.port.close(); void this.worker.terminate(); throw error; }
    this.worker.unref(); this.port.unref();
  }
  request(type, payload = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) throw Object.assign(new Error('PostgreSQL storage is closed.'), { code: 'STORAGE_CLOSED' });
    const gate = new Int32Array(new SharedArrayBuffer(4));
    this.port.postMessage({ type, ...payload, gate });
    if (Atomics.wait(gate, 0, 0, timeoutMs) === 'timed-out') {
      // A timed-out connection is never reused: a mutation outcome can be unknown.
      this.closed = true;
      this.port.postMessage({ type: 'close', gate: new Int32Array(new SharedArrayBuffer(4)) });
      throw Object.assign(new Error('PostgreSQL operation exceeded its bounded wait. Restart storage and inspect the operation outcome before retrying.'), { code: 'STORAGE_TIMEOUT' });
    }
    const envelope = receiveMessageOnPort(this.port)?.message;
    if (!envelope) throw Object.assign(new Error('PostgreSQL worker did not return a result.'), { code: 'STORAGE_PROTOCOL_ERROR' });
    if (envelope.error) throw Object.assign(new Error(envelope.error.message), envelope.error);
    return envelope.result;
  }
  prepare(sql) {
    const text = postgresParameters(sql);
    const query = (values) => this.request('query', { text, values });
    return {
      all: (...values) => query(values).rows,
      get: (...values) => query(values).rows[0],
      run: (...values) => { const result = query(values); return { changes: result.rowCount, rows: result.rows }; },
    };
  }
  exec(text) { this.request('query', { text, values: [] }); }
  hasTable(name) { return Boolean(this.prepare('SELECT 1 AS present FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=?').get(name)); }
  close() {
    if (this.closed) return;
    try { this.request('close', {}, 30_000); }
    finally { this.closed = true; this.port.close(); void this.worker.terminate(); }
  }
}
