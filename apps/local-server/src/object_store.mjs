import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function failure(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw failure('OBJECT_INVALID_CONTENT', 'Object content must be a string, Buffer, or Uint8Array.');
}

export function sha256Hex(value) {
  return createHash('sha256').update(asBuffer(value)).digest('hex');
}

export function normalizeObjectDigest(reference) {
  const candidate = typeof reference === 'string'
    ? reference
    : reference?.digest ?? reference?.id;
  const digest = String(candidate ?? '').replace(/^sha256:/, '');
  if (!SHA256_PATTERN.test(digest)) {
    throw failure('OBJECT_INVALID_REFERENCE', 'Object reference must contain a lowercase SHA-256 digest.');
  }
  return digest;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support fsync on directories. The hard-link publish
    // remains atomic even when the extra durability barrier is unavailable.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export class LocalObjectStore {
  constructor({ root, maxObjectBytes = 64 * 1024 * 1024 } = {}) {
    if (typeof root !== 'string' || !root.trim()) {
      throw failure('OBJECT_STORE_ROOT_REQUIRED', 'A local object-store root is required.');
    }
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
      throw failure('OBJECT_STORE_LIMIT_INVALID', 'maxObjectBytes must be a positive safe integer.');
    }
    this.root = resolve(root);
    this.objectsRoot = join(this.root, 'objects');
    this.maxObjectBytes = maxObjectBytes;
  }

  async initialize() {
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
    return this;
  }

  keyFor(reference) {
    const digest = normalizeObjectDigest(reference);
    return `objects/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  }

  pathFor(reference) {
    const digest = normalizeObjectDigest(reference);
    return join(this.objectsRoot, digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  referenceFor(digest, size, { deduplicated = false, mediaType } = {}) {
    return {
      id: `sha256:${digest}`,
      algorithm: 'sha256',
      digest,
      size,
      key: this.keyFor(digest),
      deduplicated,
      ...(mediaType ? { mediaType } : {}),
    };
  }

  async readVerified(reference, { maxBytes = this.maxObjectBytes } = {}) {
    const digest = normalizeObjectDigest(reference);
    const path = this.pathFor(digest);
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await handle.stat();
      if (!info.isFile()) throw failure('OBJECT_INTEGRITY_ERROR', `Object sha256:${digest} is not a regular file.`);
      if (info.size > maxBytes || info.size > this.maxObjectBytes) {
        throw failure('OBJECT_TOO_LARGE', `Object sha256:${digest} exceeds the configured read limit.`, {
          size: info.size,
          maxBytes: Math.min(maxBytes, this.maxObjectBytes),
        });
      }
      const bytes = await handle.readFile();
      if (sha256Hex(bytes) !== digest) {
        throw failure('OBJECT_INTEGRITY_ERROR', `Object sha256:${digest} failed content verification.`);
      }
      return bytes;
    } catch (error) {
      if (error.code === 'ENOENT') throw failure('OBJECT_NOT_FOUND', `Object sha256:${digest} was not found.`);
      if (error.code === 'ELOOP') throw failure('OBJECT_INTEGRITY_ERROR', `Object sha256:${digest} may not be a symbolic link.`);
      throw error;
    } finally {
      await handle?.close();
    }
  }

  async put(value, { mediaType } = {}) {
    // Snapshot caller-owned memory before hashing so mutation during async IO
    // cannot publish bytes under a digest calculated from an earlier value.
    const bytes = Buffer.from(asBuffer(value));
    if (bytes.length > this.maxObjectBytes) {
      throw failure('OBJECT_TOO_LARGE', 'Object exceeds the configured write limit.', {
        size: bytes.length,
        maxObjectBytes: this.maxObjectBytes,
      });
    }
    await this.initialize();
    const digest = sha256Hex(bytes);
    const directory = join(this.objectsRoot, digest.slice(0, 2), digest.slice(2, 4));
    const destination = join(directory, digest);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    try {
      const existing = await this.readVerified(digest);
      return this.referenceFor(digest, existing.length, { deduplicated: true, mediaType });
    } catch (error) {
      if (error.code !== 'OBJECT_NOT_FOUND') throw error;
    }

    const temporary = join(directory, `.put-${process.pid}-${randomBytes(12).toString('hex')}`);
    let handle;
    let published = false;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;

      try {
        // A hard link is an atomic, no-overwrite publication primitive. Concurrent
        // writers of identical content race safely and converge on one object.
        await link(temporary, destination);
        published = true;
        await syncDirectory(directory);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await this.readVerified(digest);
        if (existing.length !== bytes.length) {
          throw failure('OBJECT_INTEGRITY_ERROR', `Existing object sha256:${digest} has an unexpected size.`);
        }
      }
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }

    return this.referenceFor(digest, bytes.length, { deduplicated: !published, mediaType });
  }

  async get(reference, options) {
    return this.readVerified(reference, options);
  }

  async stat(reference) {
    const digest = normalizeObjectDigest(reference);
    const bytes = await this.readVerified(digest);
    return this.referenceFor(digest, bytes.length, { deduplicated: true });
  }

  async has(reference) {
    try {
      await this.readVerified(reference);
      return true;
    } catch (error) {
      if (error.code === 'OBJECT_NOT_FOUND') return false;
      throw error;
    }
  }
}
