import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIVE_WEB_RESEARCH_CAPABILITY } from './research_policy.mjs';

export const DEFAULT_PROVIDER_PROFILES = Object.freeze([
  { id: 'local-agents', label: 'Local agents', kind: 'local-planner', enabled: true, model: 'context-parser-v1' },
  { id: 'simulation', label: 'Local simulation', kind: 'local', enabled: true, model: 'deterministic-v1' },
  { id: 'codex-cli', label: 'Codex CLI', kind: 'cli', enabled: true },
  { id: 'claude-cli', label: 'Claude Code CLI', kind: 'cli', enabled: false },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', kind: 'cli', enabled: false },
  { id: 'openai-api', label: 'OpenAI API', kind: 'api', enabled: false, model: 'gpt-5.6-terra', secretEnvName: 'OPENAI_API_KEY' },
  { id: 'anthropic-api', label: 'Anthropic API', kind: 'api', enabled: false, model: 'claude-sonnet-4-5', secretEnvName: 'ANTHROPIC_API_KEY' },
  { id: 'ollama', label: 'Ollama', kind: 'local-api', enabled: false, model: 'qwen3-coder', baseUrl: 'http://127.0.0.1:11434' },
]);

export function localAgentProviderStatus(profile = DEFAULT_PROVIDER_PROFILES[0]) {
  return {
    id: 'local-agents',
    label: profile?.label || 'Local agents',
    kind: 'local-planner',
    detected: true,
    available: profile?.enabled !== false,
    configured: profile?.enabled !== false,
    ready: profile?.enabled !== false,
    connectionVerified: true,
    capabilities: profile?.enabled !== false ? ['plan'] : [],
    profile,
    detail: 'Context parser and configured agent catalog; no model, network request, project scan, or CLI probe.',
  };
}

export function commandExists(command, environment = process.env) {
  for (const directory of (environment.PATH || '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue looking in PATH without executing the command.
    }
  }
  return false;
}

function sanitizedCliEnvironment(providerId, environment) {
  const common = [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  const providerSpecific = providerId === 'codex-cli' ? ['CODEX_HOME'] : ['CLAUDE_CONFIG_DIR'];
  return Object.fromEntries([...common, ...providerSpecific]
    .filter((key) => environment[key] !== undefined)
    .map((key) => [key, environment[key]]));
}

export function inspectCliProvider(providerId, environment = process.env) {
  const command = providerId === 'codex-cli' ? 'codex' : providerId === 'claude-cli' ? 'claude' : null;
  if (!command) return { installed: false, authenticated: false, liveWebResearch: false };
  const installed = commandExists(command, environment);
  if (!installed) return { installed: false, authenticated: false, liveWebResearch: false };
  const childEnvironment = sanitizedCliEnvironment(providerId, environment);
  const args = providerId === 'codex-cli' ? ['login', 'status'] : ['auth', 'status'];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment,
  });
  let liveWebResearch = false;
  if (providerId === 'codex-cli') {
    const help = spawnSync(command, ['--help'], {
      encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment,
    });
    const disabledMode = spawnSync(command, [
      '--strict-config', '-c', 'web_search="disabled"', 'exec', '--help',
    ], {
      encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment,
    });
    liveWebResearch = help.status === 0
      && /(?:^|\n)\s*--search\b/.test(`${help.stdout || ''}\n${help.stderr || ''}`)
      && disabledMode.status === 0;
  }
  return { installed: true, authenticated: result.status === 0, liveWebResearch };
}

export function detectProviders(environment = process.env, profiles = DEFAULT_PROVIDER_PROFILES, { inspectCli = inspectCliProvider } = {}) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const profile = (id) => byId.get(id) ?? DEFAULT_PROVIDER_PROFILES.find((item) => item.id === id);
  const codexInspection = inspectCli('codex-cli', environment);
  const claudeInstalled = commandExists('claude', environment);
  const copilotInstalled = commandExists('copilot', environment);
  const ollamaInstalled = commandExists('ollama', environment);
  const openAiProfile = profile('openai-api');
  const anthropicProfile = profile('anthropic-api');
  const openAiSecretNameValid = !openAiProfile?.secretEnvName || openAiProfile.secretEnvName === 'OPENAI_API_KEY';
  const anthropicSecretNameValid = !anthropicProfile?.secretEnvName || anthropicProfile.secretEnvName === 'ANTHROPIC_API_KEY';
  const openAiConfigured = Boolean(openAiProfile?.enabled && openAiSecretNameValid && environment.OPENAI_API_KEY && openAiProfile.model);
  const anthropicConfigured = Boolean(anthropicProfile?.enabled && anthropicSecretNameValid && environment.ANTHROPIC_API_KEY && anthropicProfile.model);
  const codexInstalled = codexInspection.installed;
  const codexConfigured = codexInspection.authenticated;
  const codexLiveWebResearch = codexInspection.liveWebResearch;
  const workspaceWriteRequested = environment.EGE_ENABLE_WORKSPACE_WRITE === '1';
  const localAgentProfile = profile('local-agents');
  const simulationProfile = profile('simulation');
  const codexProfile = profile('codex-cli');
  const claudeProfile = profile('claude-cli');
  const copilotProfile = profile('copilot-cli');
  const ollamaProfile = profile('ollama');
  const ollamaConfigured = Boolean(ollamaProfile?.enabled && ollamaProfile.baseUrl && ollamaProfile.model);
  // Direct endpoint verification is asynchronous and belongs to the session connection manager.
  // Never pass an untrusted persisted URL to a CLI process from this synchronous inventory path.
  const ollamaReady = false;
  const codexExecutionEnabled = Boolean(codexProfile?.enabled && codexConfigured && workspaceWriteRequested);

  return [
    localAgentProviderStatus(localAgentProfile),
    {
      id: 'simulation',
      label: simulationProfile?.label || 'Local simulation',
      kind: 'local',
      detected: true,
      available: simulationProfile?.enabled !== false,
      configured: simulationProfile?.enabled !== false,
      capabilities: ['plan', 'execute', 'pause', 'replan', 'resume', 'artifacts'],
      profile: simulationProfile,
      detail: 'Deterministic built-in provider; it never calls an external model.',
    },
    {
      id: 'codex-cli',
      label: codexProfile?.label || 'Codex CLI',
      kind: 'cli',
      detected: codexInstalled,
      available: Boolean(codexProfile?.enabled && codexConfigured),
      configured: Boolean(codexProfile?.enabled && codexConfigured),
      ready: Boolean(codexProfile?.enabled && codexConfigured),
      capabilities: codexProfile?.enabled && codexConfigured
        ? ['chat', 'plan', ...(codexExecutionEnabled ? ['execute'] : []), ...(codexLiveWebResearch ? [LIVE_WEB_RESEARCH_CAPABILITY] : [])]
        : [],
      profile: codexProfile,
      workspaceWriteRequested,
      executionEnabled: codexExecutionEnabled,
      detail: !codexProfile?.enabled
        ? 'Provider profile is disabled.'
        : !codexInstalled
          ? 'codex executable not detected in PATH.'
          : !codexConfigured
            ? 'codex is installed but its login status is not ready.'
            : codexExecutionEnabled
              ? `Connected Codex runtime supports chat and AI planning; approval-gated workspace execution is enabled.${codexLiveWebResearch ? ' Explicitly approved live web research is supported.' : ''}`
              : `Connected Codex runtime supports chat and AI planning; workspace execution is disabled in this server mode.${codexLiveWebResearch ? ' Explicitly approved live web research is supported.' : ''}`,
    },
    {
      id: 'claude-cli',
      label: claudeProfile?.label || 'Claude Code CLI',
      kind: 'cli',
      detected: claudeInstalled,
      available: false,
      configured: Boolean(claudeProfile?.enabled && claudeInstalled),
      capabilities: [],
      profile: claudeProfile,
      detail: !claudeProfile?.enabled
        ? 'Provider profile is disabled.'
        : claudeInstalled ? 'claude executable detected, but no adapter is implemented.' : 'claude executable not detected; no adapter is implemented.',
    },
    {
      id: 'copilot-cli',
      label: copilotProfile?.label || 'GitHub Copilot CLI',
      kind: 'cli',
      detected: copilotInstalled,
      available: false,
      configured: Boolean(copilotProfile?.enabled && copilotInstalled),
      capabilities: [],
      profile: copilotProfile,
      detail: !copilotProfile?.enabled
        ? 'Provider profile is disabled.'
        : copilotInstalled ? 'copilot executable detected, but no adapter is implemented.' : 'copilot executable not detected; no adapter is implemented.',
    },
    {
      id: 'openai-api',
      label: openAiProfile?.label || 'OpenAI API',
      kind: 'api',
      detected: Boolean(environment.OPENAI_API_KEY),
      available: openAiConfigured,
      configured: openAiConfigured,
      ready: false,
      connectionVerified: false,
      capabilities: openAiConfigured ? ['chat', 'plan'] : [],
      profile: openAiProfile,
      detail: !openAiProfile?.enabled
        ? 'Provider profile is disabled.'
        : !openAiSecretNameValid
          ? 'Provider profile references a disallowed secret environment-variable name.'
          : openAiConfigured ? 'Chat and AI planning adapters are configured; verify the connection before selecting this runtime. Workspace execution is unavailable for this provider.' : 'OPENAI_API_KEY or model is not configured.',
    },
    {
      id: 'anthropic-api',
      label: anthropicProfile?.label || 'Anthropic API',
      kind: 'api',
      detected: Boolean(environment.ANTHROPIC_API_KEY),
      available: anthropicConfigured,
      configured: anthropicConfigured,
      ready: false,
      connectionVerified: false,
      capabilities: anthropicConfigured ? ['chat', 'plan'] : [],
      profile: anthropicProfile,
      detail: !anthropicProfile?.enabled
        ? 'Provider profile is disabled.'
        : !anthropicSecretNameValid
          ? 'Provider profile references a disallowed secret environment-variable name.'
          : anthropicConfigured ? 'Chat and AI planning adapters are configured; verify the connection before selecting this runtime. Workspace execution is unavailable for this provider.' : 'ANTHROPIC_API_KEY or model is not configured.',
    },
    {
      id: 'ollama',
      label: ollamaProfile?.label || 'Ollama',
      kind: 'local-api',
      detected: ollamaInstalled,
      available: ollamaReady,
      configured: ollamaConfigured,
      ready: ollamaReady,
      connectionVerified: ollamaReady,
      capabilities: ollamaReady ? ['chat', 'plan'] : [],
      profile: ollamaProfile,
      detail: !ollamaProfile?.enabled
        ? 'Provider profile is disabled.'
        : !ollamaConfigured
          ? 'Set a literal loopback base URL and installed model to configure the Ollama runtime.'
          : 'Ollama is configured but not verified in this server session; connect to its loopback /api/tags endpoint.',
    },
  ];
}
