import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeOllamaBaseUrl } from './provider_connections.mjs';

export const CHAT_PROVIDERS = ['openai-api', 'anthropic-api', 'ollama', 'codex-cli'];
const MAX_OUTPUT = 2 * 1024 * 1024;

export async function* readProviderEvents(body, { ndjson = false } = {}) {
  if (!body) throw new Error('Provider returned no response stream.');
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_OUTPUT) throw new Error('Provider response exceeded the chat output limit.');
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    let index;
    const separator = ndjson ? '\n' : '\n\n';
    while ((index = buffer.indexOf(separator)) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + separator.length);
      const data = ndjson ? block : block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
  buffer += decoder.decode();
  if (ndjson && buffer.trim()) yield JSON.parse(buffer);
}

export function buildCodexChatArguments({ directory, model }) {
  const args = ['--strict-config', '-c', 'web_search="disabled"', 'exec', '--ephemeral', '--json', '--sandbox', 'read-only', '--ignore-user-config', '-c', 'approval_policy="never"', '--skip-git-repo-check', '--color', 'never', '-C', directory];
  if (model) args.push('--model', model);
  return [...args, '-'];
}

async function codexChat({ messages, profile, environment, signal, onEvent, spawnImpl = spawn }) {
  const directory = await mkdtemp(join(tmpdir(), 'ege-chat-'));
  try {
    const allowed = ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
    const env = Object.fromEntries(allowed.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
    const args = buildCodexChatArguments({ directory, model: profile.model });
    onEvent({ type: 'activity', activity: { kind: 'cli', label: 'Codex chat · isolated read-only directory', status: 'running' } });
    await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason || new Error('Chat stopped.'));
      const child = spawnImpl('codex', args, { env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
      let buffer = '';
      let size = 0;
      let failure = null;
      let killTimer;
      const terminate = (force = false) => {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); else child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Process already ended. */ }
      };
      const abort = () => { terminate(); killTimer = setTimeout(() => terminate(true), 1000); };
      const timeout = setTimeout(() => { failure = new Error('Codex chat exceeded its five-minute limit.'); abort(); }, 300_000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) { failure = new Error('Codex response exceeded the chat output limit.'); abort(); return; }
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === 'item.completed' && event.item?.type === 'agent_message') onEvent({ type: 'delta', text: event.item.text || '' });
            if (event.type === 'item.completed' && event.item?.type === 'command_execution') onEvent({ type: 'activity', activity: { kind: 'command', label: event.item.command, status: event.item.exit_code === 0 ? 'completed' : 'failed', exitCode: event.item.exit_code } });
            if (event.type === 'turn.completed') onEvent({ type: 'usage', usage: event.usage });
            if (event.type === 'error' || event.type === 'turn.failed') failure = new Error('Codex reported a failed chat turn.');
          } catch { /* Non-JSON CLI diagnostics are not model output. */ }
        }
      });
      child.on('error', (error) => { failure = new Error(`Codex could not start (${error.code || 'unknown'}).`); });
      child.on('close', (code) => {
        clearTimeout(timeout); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(signal.reason || new Error('Chat stopped.'));
        else if (failure || code !== 0) reject(failure || new Error(`Codex chat exited with code ${code}.`));
        else resolve();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n'));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function streamChat({ providerId, profile, secret, messages, maxOutputTokens, signal, onEvent, environment = process.env, fetchImpl = globalThis.fetch, spawnImpl }) {
  if (!CHAT_PROVIDERS.includes(providerId)) throw new Error('This provider has no chat adapter. Choose a connected API provider, Ollama, or Codex CLI.');
  if (providerId === 'codex-cli') return codexChat({ messages, profile, environment, signal, onEvent, spawnImpl });
  if (providerId !== 'ollama' && !secret) throw new Error('Connect an API key before starting chat.');
  const model = profile.model;
  if (!model) throw new Error('Select a provider model before starting chat.');
  let url; let payload; let headers = { 'Content-Type': 'application/json' };
  if (providerId === 'openai-api') {
    url = 'https://api.openai.com/v1/responses';
    headers.Authorization = `Bearer ${secret}`;
    payload = { model, input: messages, stream: true, store: false };
    if (maxOutputTokens) payload.max_output_tokens = maxOutputTokens;
  } else if (providerId === 'anthropic-api') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { ...headers, 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
    payload = { model, system: messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n'), messages: messages.filter((item) => item.role !== 'system'), max_tokens: maxOutputTokens || 8192, stream: true };
  } else {
    url = `${normalizeOllamaBaseUrl(profile.baseUrl)}/api/chat`;
    payload = { model, messages, stream: true };
    if (maxOutputTokens) payload.options = { num_predict: maxOutputTokens };
  }
  onEvent({ type: 'activity', activity: { kind: 'provider', label: `${providerId} · ${model}`, status: 'running' } });
  const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal, redirect: 'error' });
  if (!response.ok) throw new Error(`Chat provider returned HTTP ${response.status}. Check its connection and model.`);
  let completed = false;
  for await (const event of readProviderEvents(response.body, { ndjson: providerId === 'ollama' })) {
    if (signal.aborted) throw signal.reason || new Error('Chat stopped.');
    if (event.error || event.type === 'error' || event.type === 'response.failed') throw new Error('Provider reported a failed chat response.');
    let delta;
    if (providerId === 'openai-api') {
      if (event.type === 'response.output_text.delta') delta = event.delta;
      if (event.type === 'response.completed') { completed = true; onEvent({ type: 'usage', usage: event.response?.usage }); }
    } else if (providerId === 'anthropic-api') {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = event.delta.text;
      if (event.type === 'message_stop') completed = true;
      if (event.type === 'message_start') onEvent({ type: 'usage', usage: event.message?.usage });
      if (event.type === 'message_delta' && event.usage) onEvent({ type: 'usage', usage: event.usage });
    } else {
      delta = event.message?.content;
      if (event.done) { completed = true; onEvent({ type: 'usage', usage: { input_tokens: event.prompt_eval_count, output_tokens: event.eval_count } }); }
    }
    if (typeof delta === 'string' && delta) onEvent({ type: 'delta', text: delta });
  }
  if (!completed) throw new Error('Provider stream ended before its completion event. Partial output was preserved.');
}
