import {
  callClaudeCli,
  isRetryableClaudeError,
  prepareResearchWorkspace as prepareClaudeResearchWorkspace,
  preflightClaudeCli,
  retryMax as claudeRetryMax,
  timeoutMs as claudeTimeoutMs,
  totalTimeoutMs as claudeTotalTimeoutMs,
} from './claude-client.mjs';
import {
  callGeminiCli,
  geminiRetryMax,
  geminiTimeoutMs,
  geminiTotalTimeoutMs,
  isRetryableGeminiError,
  prepareGeminiResearchWorkspace,
  preflightGeminiCli,
} from './gemini-client.mjs';
import {
  callCodexCli,
  codexRetryMax,
  codexTimeoutMs,
  codexTotalTimeoutMs,
  isRetryableCodexError,
  prepareCodexResearchWorkspace,
  preflightCodexCli,
} from './codex-client.mjs';

export const DEFAULT_PROVIDER_KEY = 'claude';

const definitions = Object.freeze({
  claude: Object.freeze({
    key: 'claude',
    label: 'Claude',
    cliLabel: 'Claude Code CLI',
    executableName: 'claude',
    workspacePrefix: 'trade-monitor-claude-',
    runTimeoutEnv: 'CLAUDE_RUN_TIMEOUT_MS',
    modelEnv: 'CLAUDE_CLI_MODEL',
    prepareWorkspace: prepareClaudeResearchWorkspace,
    preflight: preflightClaudeCli,
    call: callClaudeCli,
    retryMax: claudeRetryMax,
    timeoutMs: claudeTimeoutMs,
    totalTimeoutMs: claudeTotalTimeoutMs,
    isRetryable: isRetryableClaudeError,
    evidenceMode: 'cli-grounded',
  }),
  gemini: Object.freeze({
    key: 'gemini',
    label: 'Gemini',
    cliLabel: 'Gemini CLI',
    executableName: 'gemini',
    workspacePrefix: 'trade-monitor-gemini-',
    runTimeoutEnv: 'GEMINI_RUN_TIMEOUT_MS',
    modelEnv: 'GEMINI_CLI_MODEL',
    prepareWorkspace: prepareGeminiResearchWorkspace,
    preflight: preflightGeminiCli,
    call: callGeminiCli,
    retryMax: geminiRetryMax,
    timeoutMs: geminiTimeoutMs,
    totalTimeoutMs: geminiTotalTimeoutMs,
    isRetryable: isRetryableGeminiError,
    evidenceMode: 'reported-and-event-checked',
  }),
  chatgpt: Object.freeze({
    key: 'chatgpt',
    label: 'ChatGPT',
    cliLabel: 'ChatGPT (Codex CLI)',
    executableName: 'codex',
    workspacePrefix: 'trade-monitor-codex-',
    runTimeoutEnv: 'CODEX_RUN_TIMEOUT_MS',
    modelEnv: 'CODEX_CLI_MODEL',
    prepareWorkspace: prepareCodexResearchWorkspace,
    preflight: preflightCodexCli,
    call: callCodexCli,
    retryMax: codexRetryMax,
    timeoutMs: codexTimeoutMs,
    totalTimeoutMs: codexTotalTimeoutMs,
    isRetryable: isRetryableCodexError,
    evidenceMode: 'reported-and-event-checked',
  }),
});

export const providerCatalog = Object.freeze(Object.values(definitions).map((entry) => ({
  key: entry.key,
  label: entry.label,
  cliLabel: entry.cliLabel,
  executableName: entry.executableName,
})));

export function resolveProvider(value = DEFAULT_PROVIDER_KEY) {
  const key = String(value || '').trim().toLocaleLowerCase('en-US');
  const provider = definitions[key];
  if (!provider) {
    throw new Error('호출 모델은 claude, gemini, chatgpt 중 하나여야 합니다.');
  }
  return provider;
}

export function callProviderCli(providerKey, prompt, options = {}) {
  return resolveProvider(providerKey).call(prompt, options);
}

export function providerRetryMax(providerKey) {
  return resolveProvider(providerKey).retryMax();
}

export function providerTimeoutMs(providerKey) {
  return resolveProvider(providerKey).timeoutMs();
}

export function isRetryableProviderError(providerKey, error) {
  return resolveProvider(providerKey).isRetryable(error);
}
