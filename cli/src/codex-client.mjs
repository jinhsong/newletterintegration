import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  ClaudeCliError,
  executeManagedCliProcess,
} from './claude-client.mjs';
import {
  buildCliLaunchSpec,
  parseCliSemver,
  safeCliModel,
} from './cli-launch.mjs';
import {
  classifySiteFilteredQuery,
  normalizedProviderEnvelope,
} from './provider-evidence.mjs';

const PROVIDER_LABEL = 'ChatGPT (Codex CLI)';
const MAX_STREAM_EVENTS = 30000;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const preparedWorkspaces = new Set();
const verifiedFeaturePolicies = new Map();
export const CODEX_DISABLED_FEATURES = Object.freeze([
  'shell_tool',
  'unified_exec',
  'shell_zsh_fork',
  'unified_exec_zsh_fork',
  'shell_snapshot',
  'deferred_executor',
  'code_mode',
  'code_mode_host',
  'code_mode_only',
  'exec_permission_approvals',
  'request_permissions_tool',
  'goals',
  'guardian_approval',
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'enable_mcp_apps',
  'mcp_2026_07_28',
  'deferred_tool_world_state',
  'non_prefixed_mcp_tool_names',
  'tool_suggest',
  'recommended_plugins',
  'plugins',
  'executor_capability_discovery',
  'view_image',
  'in_app_browser',
  'browser_use',
  'browser_use_full_cdp_access',
  'browser_use_external',
  'computer_use',
  'remote_plugin',
  'plugin_sharing',
  'image_generation',
  'skill_search',
  'skill_mcp_dependency_install',
  'memories',
  'external_agent_memory_import',
  'chronicle',
  'tool_call_mcp_elicitation',
  'auth_elicitation',
  'artifact',
  'hooks',
  'use_agent_identity',
  'workspace_dependencies',
]);

// Codex는 도구와 무관한 내부 기능도 features list에서 활성 상태로 보고한다.
// 아래 목록 외에 새 default-on 기능이 나타나면 먼저 검토하기 전에는 실행하지 않는다.
export const CODEX_SAFE_ENABLED_FEATURES = Object.freeze([
  'enable_request_compression',
  'fast_mode',
  'in_app_updates',
  'mentions_v2',
  'personality',
  'remote_compaction_v2',
  'search_tool',
  'secret_auth_storage',
  'standalone_web_search',
  'web_search',
  'web_search_cached',
  'web_search_request',
]);
export const CODEX_SAFE_CONFIG_OVERRIDES = Object.freeze([
  'skills.include_instructions=false',
  'skills.bundled.enabled=false',
  'include_apps_instructions=false',
  'include_collaboration_mode_instructions=false',
  'include_environment_context=false',
  'include_permissions_instructions=false',
  'check_for_update_on_startup=false',
]);

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function deleteEnvironmentKey(environment, name) {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === name.toUpperCase()) delete environment[key];
  }
}

function enterpriseEnvironment() {
  const environment = { ...process.env };
  // 저장된 ChatGPT OAuth 로그인만 사용한다. API key, personal access token,
  // 사용자 지정 API endpoint가 저장된 회사 로그인을 덮어쓰지 못하게 제거한다.
  for (const name of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE',
    'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
    'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
    'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
    'CODEX_AUTHAPI_BASE_URL',
  ]) deleteEnvironmentKey(environment, name);
  environment.NO_COLOR = '1';
  return environment;
}

function classifyError(message, exitCode) {
  const value = String(message || '');
  if (/not recognized|command not found|no such file|찾을 수 없/i.test(value)) return 'CLI_NOT_FOUND';
  if (/unknown (?:argument|option)|unrecognized option|unexpected argument|invalid value/i.test(value)
    && /exec|ephemeral|git-repo|sandbox|approval|search|json|ignore-user-config|ignore-rules|disable|features?|model|config|skills?|include_/i.test(value)) {
    return 'CLI_VERSION';
  }
  if (/oauth|login|log in|sign in|authentication|credentials|unauthorized|not logged in|\b401\b/i.test(value)) return 'AUTH';
  if (/usage limit|rate.?limit|quota|resource.?exhausted|\b429\b/i.test(value)) return 'RATE_LIMIT';
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/i.test(value)) return 'TIMEOUT';
  if (/\b50[02349]\b|service unavailable|temporarily unavailable|internal server error|overloaded|backend error/i.test(value)) return 'SERVICE';
  if (/web search/i.test(value) && /disabled|unavailable|not allowed|unsupported|blocked/i.test(value)) return 'WEB_SEARCH_UNAVAILABLE';
  if (/permission denied|forbidden|approval|sandbox|policy|not allowed|blocked|\b403\b/i.test(value)) return 'POLICY';
  return exitCode === 0 ? 'BAD_OUTPUT' : 'CLI_EXIT';
}

export function codexResearchArguments(disabledFeatures = CODEX_DISABLED_FEATURES) {
  const args = [
    '--ask-for-approval', 'never',
    '--sandbox', 'read-only',
    '--search',
    ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
    ...CODEX_SAFE_CONFIG_OVERRIDES.flatMap((value) => ['--config', value]),
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--json',
    '--ignore-user-config',
  ];
  const model = String(process.env.CODEX_CLI_MODEL || '').trim();
  if (model) args.push('--model', safeCliModel(model, 'CODEX_CLI_MODEL'));
  args.push('-');
  return args;
}

export function codexFeatureArguments() {
  return [
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    'features', 'list',
  ];
}

async function execute(args, options = {}) {
  const spec = await buildCliLaunchSpec({
    args,
    defaultBin: 'codex',
    envName: 'CODEX_CLI_BIN',
    providerLabel: PROVIDER_LABEL,
  });
  return executeManagedCliProcess(spec, {
    ...options,
    providerLabel: PROVIDER_LABEL,
    classifyError,
    env: enterpriseEnvironment(),
  });
}

function normalizedWorkspace(cwd) {
  if (!cwd) throw new ClaudeCliError('SECURITY_POLICY', '격리된 Codex 작업 폴더가 지정되지 않았습니다.');
  return path.resolve(String(cwd));
}

function codexHomeDirectory() {
  const configured = String(process.env.CODEX_HOME || '').trim();
  return path.resolve(configured || path.join(os.homedir(), '.codex'));
}

async function assertNoGlobalCodexInstructions() {
  const codexHome = codexHomeDirectory();
  for (const fileName of ['AGENTS.override.md', 'AGENTS.md']) {
    const candidate = path.join(codexHome, fileName);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() && stat.size > 0) {
        throw new ClaudeCliError(
          'SECURITY_POLICY',
          'Codex 전역 AGENTS 지시문이 조사 요청에 섞일 수 있어 실행을 중단했습니다.',
          `${candidate}\n파일을 삭제하지 않습니다. 회사 정책에 따라 별도 CODEX_HOME을 사용하거나 IT 담당자에게 문의하세요.`,
        );
      }
    } catch (error) {
      if (error instanceof ClaudeCliError) throw error;
      if (error?.code !== 'ENOENT') {
        throw new ClaudeCliError(
          'SECURITY_POLICY',
          'Codex 전역 지시문 존재 여부를 안전하게 확인하지 못했습니다.',
          `${candidate}: ${error.message}`,
        );
      }
    }
  }
}

export async function prepareCodexResearchWorkspace(cwd) {
  const workspace = normalizedWorkspace(cwd);
  verifiedFeaturePolicies.delete(workspace);
  if ((await fs.readdir(workspace)).length > 0) {
    throw new ClaudeCliError('SECURITY_POLICY', 'Codex 임시 작업 폴더가 처음부터 비어 있지 않습니다.');
  }
  preparedWorkspaces.add(workspace);
  return workspace;
}

async function verifyResearchWorkspace(cwd) {
  const workspace = normalizedWorkspace(cwd);
  if (!preparedWorkspaces.has(workspace)) {
    throw new ClaudeCliError('SECURITY_POLICY', '현재 실행기가 준비하지 않은 Codex 작업 폴더입니다.');
  }
  const entries = await fs.readdir(workspace);
  if (entries.length > 0) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'Codex 임시 작업 폴더에 예상하지 않은 파일이 생겼습니다.',
      entries.join(', '),
    );
  }
  return workspace;
}

function itemType(item) {
  return String(item?.type || '');
}

function webSearchQueries(item) {
  const actionType = String(item?.action?.type || '').replaceAll('_', '').toLowerCase();
  if (actionType && actionType !== 'search') return [];
  const values = [];
  if (Array.isArray(item?.action?.queries)) values.push(...item.action.queries);
  if (typeof item?.action?.query === 'string') values.push(item.action.query);
  if (typeof item?.query === 'string') values.push(item.query);
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export function parseCodexStream(output, options = {}) {
  const lines = String(output || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3) throw new ClaudeCliError('BAD_OUTPUT', 'Codex CLI가 완전한 JSONL을 반환하지 않았습니다.');
  if (lines.length > MAX_STREAM_EVENTS) throw new ClaudeCliError('BAD_OUTPUT', 'Codex CLI 이벤트 수가 허용 범위를 초과했습니다.');

  let threadStarted = false;
  let turnStarted = false;
  let turnCompleted = false;
  const startedItems = new Map();
  const searches = [];
  const agentMessages = [];
  const warnings = [];
  let usage = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
      throw new ClaudeCliError('BAD_OUTPUT', `Codex CLI JSONL ${index + 1}번째 줄이 너무 큽니다.`);
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new ClaudeCliError('BAD_OUTPUT', `Codex CLI JSONL ${index + 1}번째 줄을 읽지 못했습니다.`, error.message);
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new ClaudeCliError('BAD_OUTPUT', `Codex CLI JSONL ${index + 1}번째 이벤트 형식이 올바르지 않습니다.`);
    }
    if (turnCompleted) throw new ClaudeCliError('BAD_OUTPUT', 'Codex CLI turn.completed 뒤에 추가 이벤트가 있습니다.');

    if (event.type === 'thread.started') {
      if (threadStarted || index !== 0 || typeof event.thread_id !== 'string') {
        throw new ClaudeCliError('BAD_OUTPUT', 'Codex CLI thread.started 이벤트가 올바르지 않습니다.');
      }
      threadStarted = true;
      continue;
    }
    if (!threadStarted) throw new ClaudeCliError('SECURITY_POLICY', 'Codex thread 검증 전에 다른 이벤트가 실행되었습니다.');
    if (event.type === 'turn.started') {
      if (turnStarted) throw new ClaudeCliError('BAD_OUTPUT', 'Codex turn.started 이벤트가 중복되었습니다.');
      turnStarted = true;
      continue;
    }
    if (!turnStarted) throw new ClaudeCliError('SECURITY_POLICY', 'Codex turn 검증 전에 다른 이벤트가 실행되었습니다.');

    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      const type = itemType(item);
      if (!id || !['reasoning', 'agent_message', 'web_search', 'todo_list', 'error'].includes(type)) {
        throw new ClaudeCliError(
          'SECURITY_POLICY',
          '허용되지 않은 Codex CLI 작업 항목이 감지되었습니다.',
          type || '(형식 없음)',
        );
      }
      if (event.type === 'item.started') {
        if (startedItems.has(id)) throw new ClaudeCliError('BAD_OUTPUT', 'Codex item.started ID가 중복되었습니다.');
        startedItems.set(id, type);
        continue;
      }
      if (event.type === 'item.updated') {
        if (!startedItems.has(id) || startedItems.get(id) !== type) {
          throw new ClaudeCliError('BAD_OUTPUT', 'Codex item.updated에 대응하는 item.started가 없습니다.');
        }
        continue;
      }
      if (startedItems.has(id) && startedItems.get(id) !== type) {
        throw new ClaudeCliError('BAD_OUTPUT', 'Codex item.started와 item.completed 형식이 일치하지 않습니다.');
      }
      startedItems.delete(id);
      if (type === 'error') {
        const detail = item.message || item.error?.message || item.text || JSON.stringify(item);
        const code = classifyError(detail, 0);
        if (code !== 'BAD_OUTPUT') {
          throw new ClaudeCliError(
            code,
            'Codex CLI 작업 항목에서 오류가 보고되었습니다.',
            String(detail).slice(0, 3000),
          );
        }
        warnings.push(String(detail).slice(0, 1000));
      } else if (type === 'agent_message') {
        if (typeof item.text !== 'string') throw new ClaudeCliError('BAD_OUTPUT', 'Codex agent_message 텍스트가 없습니다.');
        agentMessages.push({ text: item.text, phase: item.phase || '' });
      } else if (type === 'web_search') {
        const queries = webSearchQueries(item);
        queries.forEach((query, queryIndex) => {
          searches.push({
            toolUseId: queries.length === 1 ? id : `${id}:${queryIndex + 1}`,
            status: 'success',
            ...classifySiteFilteredQuery(query, options.officialDomainAllowlist || []),
          });
        });
      }
      continue;
    }
    if (event.type === 'turn.completed') {
      if (event.turn?.status && event.turn.status !== 'completed') {
        const detail = event.turn?.error?.message || JSON.stringify(event.turn);
        throw new ClaudeCliError(classifyError(detail), 'Codex CLI turn이 정상 완료되지 않았습니다.', detail);
      }
      usage = event.usage || event.turn?.usage || null;
      turnCompleted = true;
      continue;
    }
    if (event.type === 'turn.failed' || event.type === 'error') {
      const detail = event.error?.message || event.message || JSON.stringify(event);
      throw new ClaudeCliError(classifyError(detail), 'Codex CLI가 조사를 완료하지 못했습니다.', detail);
    }
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      '알려지지 않은 Codex CLI 이벤트가 감지되었습니다.',
      event.type,
    );
  }

  if (!turnCompleted) throw new ClaudeCliError('BAD_OUTPUT', 'Codex CLI turn.completed 이벤트가 없습니다.');
  if (startedItems.size > 0) throw new ClaudeCliError('BAD_OUTPUT', '완료되지 않은 Codex 작업 항목이 있습니다.');
  const finalMessage = [...agentMessages].reverse().find((entry) => entry.phase === 'final_answer')
    || agentMessages.at(-1);
  if (!finalMessage?.text?.trim()) throw new ClaudeCliError('BAD_OUTPUT', 'Codex CLI 최종 agent_message가 비어 있습니다.');
  return normalizedProviderEnvelope({
    providerLabel: PROVIDER_LABEL,
    response: finalMessage.text,
    searches,
    stats: usage,
    warnings,
  });
}

function structuredFailureDiagnostic(output) {
  const messages = [];
  for (const line of String(output || '').split(/\r?\n/).filter((entry) => entry.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    if (event.type === 'turn.failed' || event.type === 'error') {
      const detail = event.error?.message || event.message;
      if (typeof detail === 'string' && detail.trim()) messages.push(detail.trim());
    } else if (event.type === 'item.completed' && event.item?.type === 'error') {
      const detail = event.item.message || event.item.error?.message || event.item.text;
      if (typeof detail === 'string' && detail.trim()) messages.push(detail.trim());
    } else if (event.type === 'turn.completed' && event.turn?.status && event.turn.status !== 'completed') {
      const detail = event.turn?.error?.message || JSON.stringify(event.turn);
      if (detail) messages.push(String(detail));
    }
  }
  return messages.join('\n').slice(0, 3000);
}

export function parseCodexFeatureList(output) {
  return new Map(
    [...parseCodexFeatureInventory(output)].map(([name, entry]) => [name, entry.enabled]),
  );
}

export function parseCodexFeatureInventory(output) {
  const states = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/i);
    if (!match) continue;
    states.set(match[1].toLowerCase(), {
      stage: match[2].trim().toLowerCase(),
      enabled: match[3].toLowerCase() === 'true',
    });
  }
  return states;
}

export function isChatGptOAuthLoginStatus(output) {
  const lines = String(output || '').split(/\r?\n/);
  const hasChatGpt = lines.some((line) => /^\s*Logged in using ChatGPT\s*$/i.test(line));
  const hasOtherCredential = lines.some((line) => (
    /^\s*Logged in using (?!ChatGPT\s*$).+/i.test(line)
    || /\b(?:API key|Agent Identity|personal access token|PAT)\b/i.test(line)
  ));
  return hasChatGpt && !hasOtherCredential;
}

function exitFailure(result, context) {
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  const structured = structuredFailureDiagnostic(stdout);
  const diagnostic = [stderr, structured, stdout.startsWith('{') ? '' : stdout]
    .filter(Boolean)
    .join('\n');
  const code = classifyError(diagnostic, result.exitCode);
  return new ClaudeCliError(code, `${context}(${code})`, [stderr, stdout].filter(Boolean).join('\n').slice(0, 3000));
}

export function codexRetryMax() {
  return positiveInt(process.env.CODEX_CLI_RETRY_MAX, 2, 3);
}

export function codexTimeoutMs() {
  return positiveInt(process.env.CODEX_CLI_TIMEOUT_MS, 600000, 1800000);
}

export function codexPreflightTimeoutMs() {
  return positiveInt(process.env.CODEX_CLI_PREFLIGHT_TIMEOUT_MS, 60000, 300000);
}

export function codexTotalTimeoutMs() {
  return positiveInt(process.env.CODEX_RUN_TIMEOUT_MS, 7200000, 14400000);
}

export function isRetryableCodexError(error) {
  return ['TIMEOUT', 'RATE_LIMIT', 'SERVICE'].includes(error?.code);
}

export async function preflightCodexCli(options = {}) {
  const cwd = await verifyResearchWorkspace(options.cwd);
  await assertNoGlobalCodexInstructions();
  const timeoutMs = options.timeoutMs || codexPreflightTimeoutMs();
  const versionResult = await execute(['--version'], {
    cwd,
    signal: options.signal,
    timeoutMs,
    timeoutCode: 'CLI_STARTUP_TIMEOUT',
    timeoutMessage: 'Codex CLI 버전 확인이 제한 시간 안에 끝나지 않았습니다.',
  });
  await verifyResearchWorkspace(cwd);
  if (versionResult.exitCode !== 0 || versionResult.signalCode) {
    throw exitFailure(versionResult, 'Codex CLI 사전 점검 오류');
  }
  const version = parseCliSemver(
    `${versionResult.stdout}\n${versionResult.stderr}`,
    '(?:codex(?:-cli)?)',
  );
  if (!version) {
    throw new ClaudeCliError(
      'CLI_VERSION',
      '설치된 Codex CLI 버전을 확인하지 못했습니다.',
      `${versionResult.stdout}\n${versionResult.stderr}`.trim().slice(0, 1000),
    );
  }

  const featureResult = await execute(codexFeatureArguments(), {
    cwd,
    signal: options.signal,
    timeoutMs,
    timeoutCode: 'CLI_STARTUP_TIMEOUT',
    timeoutMessage: 'Codex CLI 기능 목록 확인이 제한 시간 안에 끝나지 않았습니다.',
  });
  await verifyResearchWorkspace(cwd);
  if (featureResult.exitCode !== 0 || featureResult.signalCode) {
    throw exitFailure(featureResult, 'Codex CLI 기능 확인 오류');
  }
  const featureInventory = parseCodexFeatureInventory(featureResult.stdout);
  const featureStates = new Map(
    [...featureInventory].map(([name, entry]) => [name, entry.enabled]),
  );
  const missingFeatures = CODEX_DISABLED_FEATURES.filter((feature) => !featureStates.has(feature));
  const enabledFeatures = CODEX_DISABLED_FEATURES.filter((feature) => featureStates.get(feature) === true);
  const safeEnabled = new Set(CODEX_SAFE_ENABLED_FEATURES);
  const unexpectedEnabledFeatures = [...featureInventory]
    .filter(([, entry]) => entry.enabled && entry.stage !== 'removed')
    .map(([name]) => name)
    .filter((name) => !safeEnabled.has(name) && !CODEX_DISABLED_FEATURES.includes(name));
  if (missingFeatures.length > 0 || enabledFeatures.length > 0 || unexpectedEnabledFeatures.length > 0) {
    throw new ClaudeCliError(
      'CLI_VERSION',
      '설치된 Codex CLI가 검색 전용 보안 기능 고정을 지원하거나 적용하지 못했습니다.',
      [
        missingFeatures.length > 0 ? `확인되지 않은 기능: ${missingFeatures.join(', ')}` : '',
        enabledFeatures.length > 0 ? `비활성화되지 않은 기능: ${enabledFeatures.join(', ')}` : '',
        unexpectedEnabledFeatures.length > 0
          ? `검토되지 않은 활성 기능: ${unexpectedEnabledFeatures.join(', ')}`
          : '',
      ].filter(Boolean).join('\n'),
    );
  }
  const runtimeDisabledFeatures = [...featureInventory]
    .filter(([, entry]) => entry.stage !== 'removed')
    .map(([name]) => name)
    .filter((name) => !safeEnabled.has(name));

  const authResult = await execute(['login', 'status'], {
    cwd,
    signal: options.signal,
    timeoutMs,
    timeoutCode: 'CLI_STARTUP_TIMEOUT',
    timeoutMessage: 'Codex CLI 로그인 상태 확인이 제한 시간 안에 끝나지 않았습니다.',
  });
  await verifyResearchWorkspace(cwd);
  if (authResult.exitCode !== 0 || authResult.signalCode) {
    const error = exitFailure(authResult, 'Codex CLI 로그인 확인 오류');
    throw new ClaudeCliError('AUTH', 'ChatGPT 계정으로 Codex CLI에 먼저 로그인해야 합니다.', error.details);
  }
  const authOutput = `${authResult.stdout}\n${authResult.stderr}`;
  if (!isChatGptOAuthLoginStatus(authOutput)) {
    throw new ClaudeCliError(
      'AUTH',
      'Codex CLI가 ChatGPT 계정 로그인 방식으로 연결되어 있지 않습니다.',
      `${authOutput.trim().slice(0, 1000) || '(로그인 상태 출력 없음)'}\nAPI key와 access token 로그인은 이 프로그램에서 사용하지 않습니다.`,
    );
  }
  verifiedFeaturePolicies.set(cwd, Object.freeze(runtimeDisabledFeatures));
  return {
    version: `${version.parts.join('.')}${version.prerelease}`,
    executablePath: versionResult.executablePath,
    diagnostics: { warnings: [] },
  };
}

export async function callCodexCli(prompt, options = {}) {
  const cwd = await verifyResearchWorkspace(options.cwd);
  await assertNoGlobalCodexInstructions();
  const disabledFeatures = verifiedFeaturePolicies.get(cwd);
  if (!disabledFeatures) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'Codex CLI 검색 전용 기능 사전 점검이 완료되지 않았습니다.',
    );
  }
  let result;
  try {
    result = await execute(codexResearchArguments(disabledFeatures), {
      cwd,
      signal: options.signal,
      timeoutMs: options.timeoutMs || codexTimeoutMs(),
      input: prompt,
      heartbeat: true,
    });
  } finally {
    await verifyResearchWorkspace(cwd);
  }
  if (result.exitCode !== 0 || result.signalCode) throw exitFailure(result, 'Codex CLI 오류');
  return parseCodexStream(result.stdout, options);
}
