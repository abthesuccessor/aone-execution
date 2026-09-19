import assert from 'node:assert/strict';
import test from 'node:test';
import { captureTracePayload, createSpanId, createTraceId } from '../src/trace_data.mjs';

test('trace identifiers are W3C-sized lowercase hex and never all zero', () => {
  for (let index = 0; index < 100; index += 1) {
    const traceId = createTraceId();
    const spanId = createSpanId();
    assert.match(traceId, /^[a-f0-9]{32}$/);
    assert.match(spanId, /^[a-f0-9]{16}$/);
    assert.notEqual(traceId, '0'.repeat(32));
    assert.notEqual(spanId, '0'.repeat(16));
  }
});

test('trace payload capture recursively redacts credentials while preserving numeric token usage', () => {
  const captured = captureTracePayload({
    authorization: 'Bearer secret.value.token',
    nested: {
      apiKey: 'sk-this-is-a-secret-api-key',
      token: 'opaque-token-value',
      'gen_ai.usage.input_tokens': 123,
      output_tokens: 45,
      database: 'postgres://user:password@localhost/db',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue',
    },
  });
  assert.equal(captured.payload.authorization, '[REDACTED_SECRET]');
  assert.equal(captured.payload.nested.apiKey, '[REDACTED_SECRET]');
  assert.equal(captured.payload.nested.token, '[REDACTED_SECRET]');
  assert.equal(captured.payload.nested['gen_ai.usage.input_tokens'], 123);
  assert.equal(captured.payload.nested.output_tokens, 45);
  assert.equal(JSON.stringify(captured.payload).includes('password'), false);
  assert.equal(JSON.stringify(captured.payload).includes('eyJhbGci'), false);
  assert.equal(captured.metadata.captureMode, 'REDACTED_LOCAL');
  assert.equal(captured.metadata.redacted, true);
  assert.equal(captured.metadata.truncated, false);
});

test('oversized trace payloads carry truthful bounded capture metadata', () => {
  const original = { prompt: 'x'.repeat(10_000) };
  const captured = captureTracePayload(original, 1_024);
  assert.equal(captured.payload._tracePayload, 'TRUNCATED');
  assert.equal(captured.metadata.truncated, true);
  assert.ok(captured.metadata.originalByteCount > captured.metadata.storedByteCount);
  assert.ok(Buffer.byteLength(JSON.stringify(captured.payload)) <= 1_024);
});

