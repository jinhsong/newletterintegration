import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { isTrustedOfficialDomain } from './config.mjs';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASKKILL_CAPTURE_BYTES = 64 * 1024;
const MAX_STREAM_EVENTS = 20000;
const MAX_GROUNDING_URLS = 500;
const MAX_RESULT_URLS_PER_SEARCH = 100;
const WINDOWS_TASKKILL_TIMEOUT_MS = 1000;
const WINDOWS_TASKKILL_CONFIRM_MS = 1500;
const WINDOWS_DIRECT_KILL_WAIT_MS = 1500;
const WINDOWS_WRAPPER_KILL_WAIT_MS = 250;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60000;
const MAX_PREFLIGHT_TIMEOUT_MS = 300000;
const MINIMUM_CLI_VERSION = [2, 1, 214];
const RESEARCH_TOOL = 'WebSearch';
const SPECIAL_BUILTIN_TOOL = 'EndConversation';
const WINDOWS_SYSTEM_EXECUTABLES = new Set(['cmd.exe', 'explorer.exe', 'taskkill.exe']);
const ALLOWED_STREAM_EVENT_TYPES = new Set([
  'assistant',
  'rate_limit_event',
  'result',
  'system',
  'tool_progress',
  'user',
]);
const ALLOWED_SYSTEM_EVENT_SUBTYPES = new Set([
  'api_retry',
  'compact_boundary',
  'init',
  'status',
  'thinking_tokens',
]);
const ALLOWED_COMPACT_BOUNDARY_FIELDS = new Set([
  'compact_metadata',
  'session_id',
  'subtype',
  'type',
  'uuid',
]);
const ALLOWED_COMPACT_METADATA_FIELDS = new Set(['pre_tokens', 'trigger']);
const ALLOWED_COMPACT_TRIGGERS = new Set(['auto', 'manual']);
const ALLOWED_STATUS_EVENT_FIELDS = new Set([
  'permissionMode',
  'session_id',
  'status',
  'subtype',
  'type',
  'uuid',
]);
const ALLOWED_STATUS_VALUES = new Set(['compacting', null]);
const ALLOWED_THINKING_TOKENS_EVENT_FIELDS = new Set([
  'estimated_tokens',
  'estimated_tokens_delta',
  'session_id',
  'subtype',
  'type',
  'uuid',
]);
const ALLOWED_RESULT_EVENT_SUBTYPES = new Set([
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_max_turns',
  'success',
]);
const ALLOWED_RESULT_EVENT_FIELDS = new Set([
  'api_error_status',
  'deferred_tool_use',
  'duration_api_ms',
  'duration_ms',
  'errors',
  'fast_mode_state',
  'is_error',
  'modelUsage',
  'num_turns',
  'origin',
  'permission_denials',
  'result',
  'session_id',
  'stop_reason',
  'structured_output',
  'subtype',
  'terminal_reason',
  'total_cost_usd',
  'ttft_ms',
  'type',
  'usage',
  'uuid',
]);
const ALLOWED_FAST_MODE_STATES = new Set(['cooldown', 'off', 'on']);
const ALLOWED_TERMINAL_REASONS = new Set([
  'aborted_streaming',
  'aborted_tools',
  'blocking_limit',
  'completed',
  'hook_stopped',
  'image_error',
  'max_turns',
  'model_error',
  'prompt_too_long',
  'rapid_refill_breaker',
  'stop_hook_prevented',
  'tool_deferred',
]);
const ALLOWED_RATE_LIMIT_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
const ALLOWED_RATE_LIMIT_EVENT_FIELDS = new Set([
  'rate_limit_info',
  'session_id',
  'type',
  'uuid',
]);
const ALLOWED_RATE_LIMIT_INFO_FIELDS = new Set(['resetsAt', 'status', 'utilization']);
const ALLOWED_ASSISTANT_CONTENT_BLOCK_TYPES = new Set([
  'redacted_thinking',
  'text',
  'thinking',
  'tool_use',
]);
const ALLOWED_USER_CONTENT_BLOCK_TYPES = new Set(['text', 'tool_result']);
const NON_PUBLIC_HOSTNAME_SUFFIXES = Object.freeze([
  'localhost',
  'local',
  'internal',
  'lan',
  'test',
  'invalid',
  'example',
  'onion',
  'home.arpa',
]);
const STRUCTURED_RESULT_URL_KEYS = new Set([
  'url',
  'uri',
  'href',
  'link',
  'source_url',
  'sourceUrl',
]);
const FIXED_PROMPT = [
  'Follow the complete task provided on standard input.',
  'Use WebSearch for evidence and return only the requested JSON object.',
].join(' ');
const activeChildren = new Set();
const stoppingChildren = new WeakMap();
const childLaunchMetadata = new WeakMap();
const closedChildren = new WeakSet();
const preparedWorkspaces = new Set();

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function safeModel(value) {
  const model = String(value || '').trim();
  if (!model || !/^[a-zA-Z0-9._:/\[\]-]+$/.test(model)) {
    throw new ClaudeCliError('CONFIG', 'CLAUDE_CLI_MODEL 값에 허용되지 않은 문자가 있습니다.');
  }
  return model;
}

function configuredCliBin() {
  const bin = String(process.env.CLAUDE_CLI_BIN || 'claude').trim();
  if (!bin || /[\0\r\n]/.test(bin)) {
    throw new ClaudeCliError('CONFIG', 'CLAUDE_CLI_BIN 값이 비어 있거나 줄바꿈 문자를 포함합니다.');
  }
  if (requireAbsoluteCliBin() && !path.isAbsolute(bin)) {
    throw new ClaudeCliError(
      'CONFIG',
      'CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN=1이면 CLAUDE_CLI_BIN에 절대경로를 지정해야 합니다.',
    );
  }
  return bin;
}

function requireAbsoluteCliBin() {
  const value = String(process.env.CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN || '').trim();
  if (!value || value === '0') return false;
  if (value === '1') return true;
  throw new ClaudeCliError('CONFIG', 'CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN은 0 또는 1이어야 합니다.');
}

function configuredAllowedSha256() {
  const value = String(process.env.CLAUDE_CLI_ALLOWED_SHA256 || '').trim().toLowerCase();
  if (!value) return '';
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ClaudeCliError('CONFIG', 'CLAUDE_CLI_ALLOWED_SHA256는 64자리 SHA-256 16진수여야 합니다.');
  }
  return value;
}

function sha256File(candidate) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(candidate);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyResolvedCliBinary(candidate) {
  const expectedSha256 = configuredAllowedSha256();
  if (expectedSha256) {
    let actualSha256;
    try {
      actualSha256 = await sha256File(candidate);
    } catch (error) {
      throw new ClaudeCliError(
        'SECURITY_POLICY',
        'Claude CLI 실행 파일의 SHA-256을 확인하지 못했습니다.',
        `${candidate}\n${error?.message || String(error)}`,
      );
    }
    if (actualSha256 !== expectedSha256) {
      throw new ClaudeCliError(
        'SECURITY_POLICY',
        'Claude CLI 실행 파일의 SHA-256이 허용 값과 일치하지 않습니다.',
        `실행 파일: ${candidate}\n기대: ${expectedSha256}\n감지: ${actualSha256}`,
      );
    }
  }
  return {
    absolutePathRequired: requireAbsoluteCliBin(),
    absolutePathVerified: path.isAbsolute(candidate),
    sha256Required: Boolean(expectedSha256),
    sha256Verified: Boolean(expectedSha256),
  };
}

function windowsEnvironmentValue(name, fallback = '') {
  const entry = Object.entries(process.env)
    .find(([key]) => key.toUpperCase() === name.toUpperCase());
  return String(entry?.[1] ?? fallback);
}

async function fileExists(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

export async function resolveWindowsSystemExecutable(fileName) {
  const normalizedName = String(fileName || '').toLowerCase();
  if (!WINDOWS_SYSTEM_EXECUTABLES.has(normalizedName)) {
    throw new ClaudeCliError('SECURITY_POLICY', '허용되지 않은 Windows 시스템 실행 파일을 요청했습니다.');
  }
  const systemRootValue = windowsEnvironmentValue('SystemRoot')
    || windowsEnvironmentValue('WINDIR');
  if (!systemRootValue || !path.win32.isAbsolute(systemRootValue) || /[\0\r\n]/.test(systemRootValue)) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'Windows SystemRoot 절대경로를 안전하게 확인하지 못했습니다.',
    );
  }

  const normalizedSystemRoot = path.win32.resolve(systemRootValue);
  const expectedSystemRoot = path.win32.join(path.win32.parse(normalizedSystemRoot).root, 'Windows');
  if (normalizedSystemRoot.toLowerCase() !== expectedSystemRoot.toLowerCase()) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'Windows SystemRoot가 운영체제 드라이브의 표준 Windows 폴더가 아닙니다.',
      normalizedSystemRoot,
    );
  }

  const executableDirectory = normalizedName === 'explorer.exe'
    ? normalizedSystemRoot
    : path.win32.resolve(normalizedSystemRoot, 'System32');
  const candidate = path.win32.join(executableDirectory, normalizedName);
  try {
    const [directoryRealPath, executableRealPath, executableStat] = await Promise.all([
      fs.realpath(executableDirectory),
      fs.realpath(candidate),
      fs.lstat(candidate),
    ]);
    const sameDirectory = path.win32.dirname(executableRealPath).toLowerCase()
      === directoryRealPath.toLowerCase();
    if (!executableStat.isFile() || !path.win32.isAbsolute(executableRealPath) || !sameDirectory) {
      throw new Error('Windows 시스템 폴더의 일반 실행 파일이 아닙니다.');
    }
    return executableRealPath;
  } catch (error) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      `Windows 시스템 폴더의 ${normalizedName}을 안전하게 확인하지 못했습니다.`,
      error?.message || String(error),
    );
  }
}

function supportedWindowsExecutable(candidate) {
  const extension = path.extname(candidate).toLowerCase();
  return ['.exe', '.cmd', '.bat', '.com'].includes(extension);
}

async function resolveWindowsCliBin() {
  const bin = configuredCliBin();
  if (path.isAbsolute(bin)) {
    if (!supportedWindowsExecutable(bin)) {
      throw new ClaudeCliError(
        'CONFIG',
        'Windows의 CLAUDE_CLI_BIN은 .exe, .com, .cmd 또는 .bat 파일이어야 합니다.',
      );
    }
    if (await fileExists(bin)) return path.resolve(bin);
    throw new ClaudeCliError('CLI_NOT_FOUND', `Claude CLI 실행 파일을 찾을 수 없습니다: ${bin}`);
  }
  if (/[\\/]/.test(bin)) {
    throw new ClaudeCliError(
      'CONFIG',
      'CLAUDE_CLI_BIN에 폴더를 포함할 때는 절대경로를 사용해야 합니다.',
    );
  }

  const requestedExtension = path.extname(bin);
  const extensions = requestedExtension
    ? ['']
    : windowsEnvironmentValue('PATHEXT', '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean);
  const directories = windowsEnvironmentValue('PATH')
    .split(path.delimiter)
    .map((value) => value.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${bin}${extension}`);
      if (supportedWindowsExecutable(candidate) && await fileExists(candidate)) {
        return path.resolve(candidate);
      }
    }
  }
  throw new ClaudeCliError(
    'CLI_NOT_FOUND',
    `Claude CLI 실행 파일 '${bin}'을 PATH에서 찾을 수 없습니다.`,
  );
}

async function resolveCliBin() {
  if (process.platform === 'win32') return resolveWindowsCliBin();
  const bin = configuredCliBin();
  if (path.isAbsolute(bin)) {
    try {
      await fs.access(bin, fsConstants.X_OK);
      return path.resolve(bin);
    } catch {
      throw new ClaudeCliError('CLI_NOT_FOUND', `Claude CLI 실행 파일을 찾을 수 없습니다: ${bin}`);
    }
  }
  if (/[\\/]/.test(bin)) {
    throw new ClaudeCliError(
      'CONFIG',
      'CLAUDE_CLI_BIN에 폴더를 포함할 때는 절대경로를 사용해야 합니다.',
    );
  }
  const directories = String(process.env.PATH || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, bin);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {}
  }
  throw new ClaudeCliError('CLI_NOT_FOUND', `Claude CLI 실행 파일 '${bin}'을 PATH에서 찾을 수 없습니다.`);
}

function quoteCmdToken(value, label) {
  const token = String(value);
  // cmd.exe expands percent variables even inside quotes and may expand ! when
  // delayed expansion is inherited. Refuse both rather than trying to escape an
  // administrator-supplied executable or model value through another shell.
  if (!token || /[\0\r\n"%!]/.test(token)) {
    throw new ClaudeCliError('CONFIG', `${label} 값은 Windows 명령줄에서 안전하게 전달할 수 없습니다.`);
  }
  return `"${token}"`;
}

export class ClaudeCliError extends Error {
  constructor(code, message, details = '') {
    super(message);
    this.name = 'ClaudeCliError';
    this.code = code;
    this.details = details;
  }
}

function classifyError(message, exitCode) {
  const text = String(message || '');
  if (/not recognized|command not found|no such file|찾을 수 없/i.test(text)) return 'CLI_NOT_FOUND';
  if (
    /unknown (?:argument|option)|unknown arguments|unrecognized option|invalid values?.*argument/i.test(text)
    && /safe-mode|no-chrome|disable-slash|strict-mcp|disallowed|allowed.?tools|tools|permission-mode|session-persistence|output-format|include-hook-events|max-turns/i.test(text)
  ) return 'CLI_VERSION';
  if (/error_max_turns|max(?:imum)? turns?|turn limit/i.test(text)) return 'TURN_LIMIT';
  if (/error_max_budget|budget limit|max-budget/i.test(text)) return 'BUDGET_LIMIT';
  if (/websearch|web search/i.test(text)
    && /not (?:available|supported)|unavailable|unsupported|disabled|does not support|사용할 수 없|지원하지 않/i.test(text)) {
    return 'WEB_SEARCH_UNAVAILABLE';
  }
  if (/\b429\b|rate.?limit|quota|usage limit|resource.?exhausted/i.test(text)) return 'RATE_LIMIT';
  if (/timeout|timed out|시간 초과|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|socket is closed|unable to connect|connection (?:refused|failed)/i.test(text)) {
    return 'TIMEOUT';
  }
  if (/\b50[02349]\b|service unavailable|temporarily unavailable|internal server error|overloaded|backend error/i.test(text)) {
    return 'SERVICE';
  }
  if (/oauth_org_not_allowed|wrong organization|organization.*(?:blocked|not allowed)/i.test(text)) {
    return 'AUTH_ORG';
  }
  if (/oauth|login|log in|sign in|authentication|credentials|unauthorized|access token|not logged in|\b401\b/i.test(text)) {
    return 'AUTH';
  }
  if (/permission_denials?|permission denied|forbidden|policy|not allowed|blocked|\b403\b/i.test(text)) {
    return 'POLICY';
  }
  if (exitCode === 143) return 'ABORTED';
  return 'CLI_EXIT';
}

function createCapture(maximumBytes) {
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  return {
    append(chunk) {
      if (exceeded) return false;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (bytes + buffer.length > maximumBytes) {
        exceeded = true;
        return false;
      }
      chunks.push(buffer);
      bytes += buffer.length;
      return true;
    },
    text(label) {
      const buffer = Buffer.concat(chunks, bytes);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new ClaudeCliError('BAD_OUTPUT', `${label}이 올바른 UTF-8 형식이 아닙니다.`);
      }
    },
  };
}

function maxTurns() {
  return positiveInt(process.env.CLAUDE_CLI_MAX_TURNS, 32, 50);
}

function researchArguments() {
  const args = [
    '--safe-mode',
    '--no-chrome',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--disallowedTools', 'mcp__*',
    '--tools', RESEARCH_TOOL,
    '--allowedTools', RESEARCH_TOOL,
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--max-turns', String(maxTurns()),
  ];
  const model = String(process.env.CLAUDE_CLI_MODEL || '').trim();
  if (model) args.push('--model', safeModel(model));
  args.push('-p', FIXED_PROMPT);
  return args;
}

async function launchSpec(args) {
  const bin = await resolveCliBin();
  const executableVerification = await verifyResolvedCliBinary(bin);
  if (process.platform !== 'win32') {
    return {
      command: bin,
      args,
      windowsVerbatimArguments: false,
      executablePath: bin,
      executableVerification,
    };
  }

  const extension = path.extname(bin).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    return {
      command: bin,
      args,
      windowsVerbatimArguments: false,
      executablePath: bin,
      executableVerification,
    };
  }
  if (executableVerification.sha256Required) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'SHA-256 고정은 실제 실행 payload를 직접 가리키는 native .exe/.com에만 사용할 수 있습니다.',
      `래퍼 실행 파일은 하위 Node/JavaScript payload의 무결성을 보장하지 않습니다: ${bin}`,
    );
  }

  const commandLine = [
    quoteCmdToken(bin, 'CLAUDE_CLI_BIN'),
    ...args.map((arg) => quoteCmdToken(arg, 'Claude CLI 인자')),
  ].join(' ');
  return {
    command: await resolveWindowsSystemExecutable('cmd.exe'),
    args: ['/d', '/q', '/v:off', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
    executablePath: bin,
    executableVerification,
  };
}

function deleteEnvironmentKey(env, name) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
}

function enterpriseEnvironment() {
  // Claude Enterprise authentication, gateway routing, proxies, CAs and MDM
  // settings may depend on vendor- or company-specific variables. Preserve the
  // user's environment instead of maintaining a brittle allowlist.
  const env = { ...process.env };
  for (const key of [
    'CLAUDE_CODE_SYNC_PLUGIN_INSTALL',
    'CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS',
    'CLAUDE_CODE_SYNC_SKILLS',
    'CLAUDE_CODE_SYNC_SKILLS_INSTALL_TIMEOUT_MS',
    'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  ]) deleteEnvironmentKey(env, key);

  // These settings duplicate CLI restrictions so an enterprise wrapper that
  // forwards environment more faithfully than argv still fails closed.
  env.CLAUDE_CODE_SAFE_MODE = '1';
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
  env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1';
  env.CLAUDE_CODE_DISABLE_ARTIFACT = '1';
  env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  // Do not activate CLAUDE_CODE_SUBPROCESS_ENV_SCRUB here. Recent enterprise
  // hardening can force `dontAsk` back to `default` when it is enabled. Any
  // company-managed value already present in process.env remains inherited.
  env.DISABLE_AUTOUPDATER = '1';
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  env.NO_COLOR = '1';
  return env;
}

export function sensitiveEnvironmentVariableNames(environment = process.env) {
  if (!environment || typeof environment !== 'object') return [];
  return Object.keys(environment)
    .filter((name) => name.length <= 256)
    .filter((name) => (
      /(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|OAUTH[_-]?TOKEN|SESSION[_-]?TOKEN|SECRET(?:[_-]?KEY)?|PASSWORD|BASE[_-]?URL)$/i.test(name)
      || /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)
      || /^(?:NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name)
    ))
    .sort((left, right) => left.localeCompare(right, 'en-US'))
    .slice(0, 100);
}

function normalizedWorkspace(cwd) {
  if (!cwd) {
    throw new ClaudeCliError('SECURITY_POLICY', '격리된 Claude 작업 폴더가 지정되지 않았습니다.');
  }
  return path.resolve(String(cwd));
}

export async function prepareResearchWorkspace(cwd) {
  const workspace = normalizedWorkspace(cwd);
  let stat;
  try {
    stat = await fs.stat(workspace);
  } catch (error) {
    throw new ClaudeCliError('SECURITY_POLICY', '격리된 Claude 작업 폴더를 읽지 못했습니다.', error.message);
  }
  if (!stat.isDirectory()) {
    throw new ClaudeCliError('SECURITY_POLICY', '격리된 Claude 작업 경로가 폴더가 아닙니다.', workspace);
  }
  const entries = await fs.readdir(workspace);
  if (entries.length > 0) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'Claude 작업 폴더가 비어 있지 않아 안전한 조사를 시작하지 않았습니다.',
      workspace,
    );
  }
  const real = await fs.realpath(workspace);
  preparedWorkspaces.add(real.toLowerCase());
  return real;
}

async function verifyResearchWorkspace(cwd) {
  const workspace = normalizedWorkspace(cwd);
  let real;
  try {
    real = await fs.realpath(workspace);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new ClaudeCliError('SECURITY_POLICY', '격리된 Claude 작업 폴더를 확인하지 못했습니다.', error.message);
  }
  if (!preparedWorkspaces.has(real.toLowerCase())) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      '준비되지 않은 폴더에서 Claude CLI 실행을 거부했습니다.',
      real,
    );
  }
  const entries = await fs.readdir(real);
  if (entries.length > 0) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      '격리된 Claude 작업 폴더에 예상하지 않은 파일이 생겨 결과를 폐기했습니다.',
      entries.slice(0, 20).join(', '),
    );
  }
  return real;
}

function waitForChildClose(child, waitMs) {
  if (!child || closedChildren.has(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let completed = false;
    let timer;
    const done = (closed) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => done(true);
    child.once('close', onClose);
    timer = setTimeout(() => done(false), waitMs);
    timer.unref?.();
    if (closedChildren.has(child)) done(true);
  });
}

function posixProcessGroupState(pid) {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
    return { alive: false, error: '' };
  }
  try {
    process.kill(-pid, 0);
    return { alive: true, error: '' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { alive: false, error: '' };
    if (error?.code === 'EPERM') return { alive: true, error: '프로세스 그룹 상태 확인 권한이 없습니다.' };
    return { alive: true, error: `프로세스 그룹 상태 확인 실패: ${error?.message || String(error)}` };
  }
}

function signalPosixProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return { sent: true, absent: false, error: '' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { sent: false, absent: true, error: '' };
    return {
      sent: false,
      absent: false,
      error: `${signal} 프로세스 그룹 종료 실패: ${error?.message || String(error)}`,
    };
  }
}

async function waitForPosixProcessGroupExit(pid, waitMs) {
  const deadline = Date.now() + waitMs;
  let state = posixProcessGroupState(pid);
  while (state.alive && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = posixProcessGroupState(pid);
  }
  return state;
}

async function runTaskkill(pid, dependencies = {}) {
  const resolveExecutable = dependencies.resolveExecutable || resolveWindowsSystemExecutable;
  const spawnProcess = dependencies.spawnProcess || spawn;
  const stopAfterMs = Number.isSafeInteger(dependencies.stopAfterMs)
    && dependencies.stopAfterMs > 0
    && dependencies.stopAfterMs <= 60000
    ? dependencies.stopAfterMs
    : WINDOWS_TASKKILL_TIMEOUT_MS;
  const abandonAfterMs = Number.isSafeInteger(dependencies.abandonAfterMs)
    && dependencies.abandonAfterMs > stopAfterMs
    && dependencies.abandonAfterMs <= 60500
    ? dependencies.abandonAfterMs
    : Math.max(WINDOWS_TASKKILL_CONFIRM_MS, stopAfterMs + 500);
  let taskkillPath;
  try {
    taskkillPath = await resolveExecutable('taskkill.exe');
  } catch (error) {
    return {
      code: null,
      details: `taskkill 시스템 경로 확인 실패: ${error?.message || String(error)}`,
    };
  }
  if (typeof dependencies.isTargetExited === 'function') {
    try {
      if (dependencies.isTargetExited()) {
        return {
          code: null,
          details: 'Claude 루트 프로세스가 taskkill 시작 전에 종료되어 PID 재사용 위험을 피하도록 중단했습니다.',
        };
      }
    } catch (error) {
      return {
        code: null,
        details: `Claude 루트 프로세스 상태 재확인 실패로 taskkill을 중단했습니다: ${error?.message || String(error)}`,
      };
    }
  }
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawnProcess(taskkillPath, ['/pid', String(pid), '/T', '/F'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, details: `taskkill 실행 실패: ${error.message}` });
      return;
    }
    const capture = createCapture(MAX_TASKKILL_CAPTURE_BYTES);
    let finished = false;
    let timedOut = false;
    let truncated = false;
    let stopTimer;
    let confirmationTimer;
    let forcedKillFailure = '';
    killer.stdout?.on('data', (chunk) => { if (!capture.append(chunk)) truncated = true; });
    killer.stderr?.on('data', (chunk) => { if (!capture.append(chunk)) truncated = true; });
    const done = (code = null, fallback = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(stopTimer);
      clearTimeout(confirmationTimer);
      const suffix = truncated ? ' (출력 일부 생략)' : '';
      let output = '';
      try { output = capture.text('taskkill 출력').trim(); } catch {}
      const details = [output, fallback].filter(Boolean).join('\n');
      resolve({ code, details: `${details}${suffix}`.trim() });
    };
    const requestForcedKill = () => {
      try {
        if (killer.kill('SIGKILL') === false) {
          forcedKillFailure = 'taskkill에 강제 종료 신호를 전달하지 못했습니다.';
        }
      } catch (error) {
        forcedKillFailure = `taskkill 강제 종료 실패: ${error?.message || String(error)}`;
      }
    };
    const detachKiller = () => {
      // If endpoint security keeps taskkill itself from emitting `close`, do
      // not let its process or captured pipes keep this Node process alive.
      try {
        killer.stdout?.once('error', () => {});
        killer.stdout?.destroy();
      } catch {}
      try {
        killer.stderr?.once('error', () => {});
        killer.stderr?.destroy();
      } catch {}
      try { killer.unref(); } catch {}
    };
    confirmationTimer = setTimeout(() => {
      timedOut = true;
      requestForcedKill();
      detachKiller();
      done(null, [
        `taskkill 종료 명령이 ${abandonAfterMs}ms 안에 끝나지 않아 중단했습니다.`,
        forcedKillFailure,
      ].filter(Boolean).join('\n'));
    }, abandonAfterMs);
    stopTimer = setTimeout(() => {
      timedOut = true;
      requestForcedKill();
    }, stopAfterMs);
    if (dependencies.unrefTimers !== false) {
      stopTimer.unref?.();
      confirmationTimer.unref?.();
    }
    killer.once('error', (error) => {
      detachKiller();
      done(null, `taskkill 실행 오류: ${error?.message || String(error)}`);
    });
    killer.once('close', (code, signal) => {
      if (timedOut) {
        done(null, `taskkill 종료 명령이 ${stopAfterMs}ms 안에 끝나지 않아 중단했습니다.`);
        return;
      }
      done(code, signal ? `taskkill이 ${signal} 신호로 종료됨` : '');
    });
  });
}

export function __runTaskkillForTest(pid, dependencies) {
  if (
    typeof dependencies?.resolveExecutable !== 'function'
    || typeof dependencies?.spawnProcess !== 'function'
  ) {
    throw new TypeError('테스트용 taskkill 실행에는 resolveExecutable과 spawnProcess가 모두 필요합니다.');
  }
  return runTaskkill(pid, dependencies);
}

function windowsLaunchKind(child) {
  const executablePath = childLaunchMetadata.get(child)?.executablePath || '';
  const extension = path.extname(executablePath).toLowerCase();
  return extension === '.exe' || extension === '.com' ? 'native' : 'wrapper';
}

function appendCleanupDetail(current, detail) {
  return [current, detail].filter(Boolean).join('\n');
}

function stopProcessTree(child, taskkillRunner = null) {
  if (!child) {
    return Promise.resolve({ closed: true, treeConfirmed: true, details: '' });
  }
  const existing = stoppingChildren.get(child);
  if (existing) return existing;
  if (
    closedChildren.has(child)
    && (
      process.platform === 'win32'
      || !posixProcessGroupState(child.pid).alive
    )
  ) {
    const windowsTreeUnconfirmed = process.platform === 'win32'
      && windowsLaunchKind(child) !== 'native';
    return Promise.resolve({
      closed: true,
      treeConfirmed: !windowsTreeUnconfirmed,
      details: windowsTreeUnconfirmed
        ? 'Windows 배치 래퍼가 먼저 종료되어 하위 CLI 프로세스 종료를 확인할 수 없습니다.'
        : '',
    });
  }

  const stopping = (async () => {
    let treeConfirmed = true;
    let details = '';
    const rootAlreadyExited = child.exitCode !== null || child.signalCode !== null;
    if (process.platform === 'win32' && rootAlreadyExited) {
      treeConfirmed = false;
      details = 'AI CLI 루트 프로세스가 이미 종료되어 PID 재사용 위험을 피하도록 taskkill을 생략했습니다.';
    } else if (process.platform === 'win32' && child.pid) {
      const killed = taskkillRunner
        ? await taskkillRunner(child.pid)
        : await runTaskkill(child.pid, {
          isTargetExited: () => child.exitCode !== null || child.signalCode !== null,
        });
      treeConfirmed = killed.code === 0;
      details = killed.details || (treeConfirmed ? '' : `taskkill 종료 코드 ${killed.code}`);
      if (!treeConfirmed) {
        // Enterprise endpoint policies sometimes deny taskkill even for a process
        // created by the current user. Terminate the process handle that Node owns
        // immediately so a native .exe cannot linger. A .cmd/.bat launch remains
        // fail-closed: closing cmd.exe does not prove that its CLI child exited.
        let directKillSent = false;
        if (child.exitCode === null && child.signalCode === null) {
          try { directKillSent = child.kill('SIGKILL'); } catch (error) {
            details = appendCleanupDetail(details, `직접 종료 실패: ${error?.message || String(error)}`);
          }
        }
        const directWaitMs = windowsLaunchKind(child) === 'native'
          ? WINDOWS_DIRECT_KILL_WAIT_MS
          : WINDOWS_WRAPPER_KILL_WAIT_MS;
        const directlyClosed = directKillSent
          ? await waitForChildClose(child, directWaitMs)
          : (closedChildren.has(child) || await waitForChildClose(child, directWaitMs));
        if (windowsLaunchKind(child) === 'native' && directlyClosed) {
          treeConfirmed = false;
          details = appendCleanupDetail(
            details,
            '직접 실행한 native CLI 루트 프로세스는 종료했지만 하위 프로세스 트리의 종료는 확인할 수 없습니다.',
          );
        } else if (windowsLaunchKind(child) !== 'native') {
          details = appendCleanupDetail(
            details,
            'AI CLI 실행 파일이 .cmd/.bat 래퍼이므로 하위 프로세스가 남아 있을 수 있고 종료를 확인할 수 없습니다.',
          );
        }
      }
    } else if (Number.isSafeInteger(child.pid) && child.pid > 0) {
      const terminated = signalPosixProcessGroup(child.pid, 'SIGTERM');
      if (terminated.error) details = terminated.error;
      let groupState = terminated.absent
        ? { alive: false, error: '' }
        : await waitForPosixProcessGroupExit(child.pid, 7000);
      if (groupState.alive) {
        const killed = signalPosixProcessGroup(child.pid, 'SIGKILL');
        if (killed.error) details = [details, killed.error].filter(Boolean).join('\n');
        groupState = killed.absent
          ? { alive: false, error: '' }
          : await waitForPosixProcessGroupExit(child.pid, 1500);
      }
      treeConfirmed = !groupState.alive;
      if (!treeConfirmed) {
        details = [
          details,
          groupState.error,
          'POSIX 프로세스 그룹의 완전한 종료를 확인하지 못했습니다.',
        ].filter(Boolean).join('\n');
      }
    } else {
      try { child.kill('SIGTERM'); } catch {}
      treeConfirmed = false;
      details = 'POSIX 프로세스 그룹 ID를 확인하지 못해 자식 프로세스 트리 종료를 보장할 수 없습니다.';
    }

    let closed = await waitForChildClose(child, 500);
    if (!closed && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        try { child.kill('SIGKILL'); } catch {}
      } else if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        const killed = signalPosixProcessGroup(child.pid, 'SIGKILL');
        if (killed.error) details = [details, killed.error].filter(Boolean).join('\n');
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
      closed = await waitForChildClose(child, 1500);
      if (process.platform === 'win32' && windowsLaunchKind(child) !== 'native') treeConfirmed = false;
    }
    if (!closed) {
      // Keep the fail-closed result, but release this parent's pipe/process
      // handles so an uncooperative endpoint cannot keep the runner alive.
      try {
        child.stdin?.once('error', () => {});
        child.stdin?.destroy();
      } catch {}
      try {
        child.stdout?.once('error', () => {});
        child.stdout?.destroy();
      } catch {}
      try {
        child.stderr?.once('error', () => {});
        child.stderr?.destroy();
      } catch {}
      try { child.unref(); } catch {}
      details = appendCleanupDetail(
        details,
        '종료되지 않은 AI CLI 프로세스의 부모 측 핸들을 분리했습니다. 프로세스 트리 종료는 확인되지 않았습니다.',
      );
    }
    return { closed, treeConfirmed, details };
  })();
  const tracked = stopping.then(
    (result) => {
      // A process that is still open may become stoppable after a transient
      // endpoint-policy or OS error. Do not cache that failed attempt forever.
      if (
        !result.closed
        && child.exitCode === null
        && child.signalCode === null
        && stoppingChildren.get(child) === tracked
      ) {
        stoppingChildren.delete(child);
      }
      return result;
    },
    (error) => {
      if (stoppingChildren.get(child) === tracked) stoppingChildren.delete(child);
      throw error;
    },
  );
  stoppingChildren.set(child, tracked);
  return tracked;
}

// Narrow test seam for proving Windows cleanup behavior when endpoint policy
// denies taskkill. It cannot target a PID by itself: the caller must already
// own a ChildProcess handle. Production execution always uses runTaskkill.
export function __stopProcessTreeForTest(child, executablePath, taskkillResult) {
  childLaunchMetadata.set(child, { executablePath: path.resolve(String(executablePath || '')) });
  child.once('close', () => closedChildren.add(child));
  const taskkillRunner = typeof taskkillResult === 'function'
    ? taskkillResult
    : async () => ({ ...taskkillResult });
  return stopProcessTree(child, taskkillRunner);
}

export function createProcessCleanupError(originalError, cleanup = {}, pid = null) {
  const originalCode = String(originalError?.code || 'UNKNOWN');
  const originalMessage = String(originalError?.message || originalError || '알 수 없는 오류');
  const originalDetails = String(originalError?.details || '').trim();
  const cleanupDetails = String(cleanup?.details || '프로세스 트리의 완전한 종료를 확인하지 못했습니다.').trim();
  const cleanupState = `closed=${cleanup?.closed === true}, treeConfirmed=${cleanup?.treeConfirmed === true}`;
  const details = [
    `원래 오류 (${originalCode}): ${originalMessage}`,
    originalDetails ? `원래 오류 상세: ${originalDetails.slice(0, 1500)}` : '',
    `정리 결과: ${cleanupState}; ${cleanupDetails.slice(0, 1500)}`,
    `PID: ${Number.isSafeInteger(pid) && pid > 0 ? pid : '(확인 불가)'}`,
  ].filter(Boolean).join('\n');
  return new ClaudeCliError(
    'PROCESS_CLEANUP',
    'AI CLI 프로세스 트리 종료를 확인하지 못해 실행을 중단했습니다.',
    details,
  );
}

export function resolveForcedStopError(originalError, cleanup = {}, pid = null) {
  if (cleanup?.closed === true && cleanup?.treeConfirmed === true) return originalError;
  return createProcessCleanupError(originalError, cleanup, pid);
}

export async function stopAllClaudeProcesses() {
  const children = [...activeChildren];
  const statuses = await Promise.allSettled(children.map((child) => stopProcessTree(child)));
  const processes = statuses.map((status, index) => {
    const child = children[index];
    const pid = child?.pid ?? null;
    const providerLabel = childLaunchMetadata.get(child)?.providerLabel || 'AI CLI';
    if (status.status === 'rejected') {
      return {
        pid,
        providerLabel,
        closed: false,
        treeConfirmed: false,
        details: `프로세스 정리 중 오류: ${status.reason?.message || String(status.reason)}`,
      };
    }
    return { pid, providerLabel, ...status.value };
  });
  for (const status of processes) {
    if (!status.closed || !status.treeConfirmed) {
      console.warn(
        `${status.providerLabel} 프로세스 트리 종료 실패(PID ${status.pid ?? '확인 불가'}): ${status.details || '완전한 종료를 확인하지 못했습니다.'}`,
      );
    }
  }
  return { ok: processes.every((status) => status.closed && status.treeConfirmed), processes };
}

// 모든 공급자 어댑터가 같은 프로세스 감독기를 사용한다. 기존 export는 하위 호환을 위해 유지한다.
export async function stopAllProviderProcesses() {
  return stopAllClaudeProcesses();
}

export function isRetryableClaudeError(error) {
  return ['TIMEOUT', 'RATE_LIMIT', 'SERVICE'].includes(error?.code);
}

export function retryMax() {
  return positiveInt(process.env.CLAUDE_CLI_RETRY_MAX, 2, 3);
}

export function timeoutMs() {
  return positiveInt(process.env.CLAUDE_CLI_TIMEOUT_MS, 600000, 1800000);
}

export function preflightTimeoutMs() {
  return positiveInt(
    process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS,
    DEFAULT_PREFLIGHT_TIMEOUT_MS,
    MAX_PREFLIGHT_TIMEOUT_MS,
  );
}

export function totalTimeoutMs() {
  return positiveInt(process.env.CLAUDE_RUN_TIMEOUT_MS, 5400000, 14400000);
}

function signalError(signal) {
  const reason = signal?.reason;
  return reason?.code === 'RUN_TIMEOUT'
    ? new ClaudeCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
    : new ClaudeCliError('ABORTED', '사용자가 실행을 중단했습니다.');
}

export function executeManagedCliProcess(spec, options = {}) {
  const timeout = positiveInt(options.timeoutMs, DEFAULT_PREFLIGHT_TIMEOUT_MS, 1800000);
  const providerLabel = String(options.providerLabel || 'AI CLI').trim() || 'AI CLI';
  const classify = typeof options.classifyError === 'function'
    ? options.classifyError
    : classifyError;
  const environment = options.env && typeof options.env === 'object'
    ? options.env
    : process.env;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(signalError(options.signal));
      return;
    }

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : classify(error?.message);
      reject(new ClaudeCliError(code, `${providerLabel}를 실행하지 못했습니다: ${error.message}`));
      return;
    }

    childLaunchMetadata.set(child, {
      executablePath: spec.executablePath,
      providerLabel,
    });
    child.once('close', () => {
      closedChildren.add(child);
      activeChildren.delete(child);
    });
    activeChildren.add(child);
    const stdoutCapture = createCapture(MAX_CAPTURE_BYTES);
    const stderrCapture = createCapture(MAX_CAPTURE_BYTES);
    let settled = false;
    let forcedError = null;
    let timer;
    let heartbeat;
    const startedAt = Date.now();

    const finish = (worker) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      options.signal?.removeEventListener('abort', onAbort);
      worker();
    };

    const forceStop = async (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      let cleanup;
      try {
        cleanup = await stopProcessTree(child);
      } catch (cleanupError) {
        cleanup = {
          closed: false,
          treeConfirmed: false,
          details: `프로세스 정리 중 오류: ${cleanupError?.message || String(cleanupError)}`,
        };
      }
      finish(() => reject(resolveForcedStopError(error, cleanup, child.pid)));
    };

    const onAbort = () => {
      void forceStop(signalError(options.signal));
    };

    timer = setTimeout(() => {
      const timeoutMessage = options.timeoutMessage
        || `${providerLabel} 응답이 ${Math.max(1, Math.round(timeout / 60000))}분 안에 끝나지 않았습니다.`;
      void forceStop(new ClaudeCliError(options.timeoutCode || 'TIMEOUT', timeoutMessage));
    }, timeout);

    if (options.heartbeat) {
      heartbeat = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ... ${providerLabel} 조사 중 (${seconds}초 경과)`);
      }, 20000);
      heartbeat.unref();
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    child.stdout.on('data', (chunk) => {
      if (!stdoutCapture.append(chunk)) {
        void forceStop(new ClaudeCliError('BAD_OUTPUT', `${providerLabel} 출력이 허용 크기를 초과했습니다.`));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!stderrCapture.append(chunk)) {
        void forceStop(new ClaudeCliError('BAD_OUTPUT', `${providerLabel} 오류 출력이 허용 크기를 초과했습니다.`));
      }
    });
    child.stdin.on('error', (error) => {
      if (!forcedError && !['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) {
        void forceStop(new ClaudeCliError('CLI_EXIT', `${providerLabel} 입력 전달 오류: ${error.message}`));
      }
    });
    child.on('error', (error) => {
      if (forcedError) return;
      const code = error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : classify(error.message);
      const cliError = new ClaudeCliError(code, `${providerLabel} 실행 오류: ${error.message}`);
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        void forceStop(cliError);
        return;
      }
      activeChildren.delete(child);
      finish(() => reject(cliError));
    });
    child.on('close', (exitCode, signalCode) => {
      if (forcedError) return;
      finish(() => {
        try {
          resolve({
            stdout: stdoutCapture.text(`${providerLabel} 표준 출력`),
            stderr: stderrCapture.text(`${providerLabel} 오류 출력`),
            exitCode,
            signalCode,
            executablePath: spec.executablePath,
            executableVerification: spec.executableVerification,
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, 'utf8');
  });
}

async function executeCli(args, options = {}) {
  const spec = await launchSpec(args);
  return executeManagedCliProcess(spec, {
    ...options,
    providerLabel: 'Claude CLI',
    classifyError,
    env: enterpriseEnvironment(),
  });
}

function exitFailure(result, contextMessage) {
  const stdout = result.stdout.trim().slice(0, 3000);
  const stderr = result.stderr.trim().slice(0, 3000);
  // Never classify arbitrary model/tool JSON as a CLI diagnostic. A response
  // can legitimately discuss a "policy", "403", or "rate limit".
  const stdoutDiagnostic = stdout.startsWith('{') ? '' : stdout;
  const combined = [stderr, stdoutDiagnostic].filter(Boolean).join('\n');
  const detail = [stderr, stdout].filter(Boolean).join('\n').slice(0, 3000);
  const code = classifyError(combined, result.exitCode);
  return new ClaudeCliError(code, `${contextMessage}(${code})`, detail);
}

function metric(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function extractToolEvidence(value) {
  const source = value?.toolEvidence && typeof value.toolEvidence === 'object'
    ? value.toolEvidence
    : value;
  const rawByName = source?.byName && typeof source.byName === 'object' ? source.byName : {};
  const rawSearch = rawByName.WebSearch && typeof rawByName.WebSearch === 'object'
    ? rawByName.WebSearch
    : {};
  const search = {
    count: metric(rawSearch.count),
    success: metric(rawSearch.success),
    fail: metric(rawSearch.fail),
  };
  return {
    available: source?.available === true,
    totalCalls: metric(source?.totalCalls),
    totalSuccess: metric(source?.totalSuccess),
    totalFail: metric(source?.totalFail),
    byName: { WebSearch: search },
  };
}

function normalizeWarnings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ClaudeCliError('BAD_OUTPUT', 'Claude CLI 응답의 warnings 형식이 올바르지 않습니다.');
  }
  return value.map((warning) => (
    typeof warning === 'string' ? warning : JSON.stringify(warning)
  )).filter(Boolean);
}

function publicHostname(value) {
  const hostname = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  const labels = hostname.split('.');
  if (
    !hostname
    || hostname.length > 253
    || !hostname.includes('.')
    || !/^[a-z0-9.-]+$/i.test(hostname)
    || labels.some((label) => (
      !label
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    ))
    || isIP(hostname)
    || NON_PUBLIC_HOSTNAME_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  ) return '';
  return hostname;
}

function safeEvidenceUrl(value) {
  let raw = String(value || '').trim();
  raw = raw.replace(/[),.;:!?\]}]+$/g, '');
  if (!raw || raw.length > 4096) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password || !parsed.hostname) return '';
    if (parsed.port && parsed.port !== '443') return '';
    if (!publicHostname(parsed.hostname)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function collectStructuredResultUrls(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.results)) {
    return [];
  }
  const output = [];
  const seen = new Set();
  const collectDirect = (entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    for (const key of STRUCTURED_RESULT_URL_KEYS) {
      const url = typeof entry[key] === 'string' ? safeEvidenceUrl(entry[key]) : '';
      if (url && !seen.has(url) && output.length < MAX_RESULT_URLS_PER_SEARCH) {
        seen.add(url);
        output.push(url);
      }
    }
  };
  for (const result of value.results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    collectDirect(result);
    // Claude Code의 현재 WebSearch 계약은 각 result의 content 배열에 실제
    // 검색 결과 항목을 둘 수 있다. 이 한 단계만 명시적으로 허용하고
    // metadata/related/thumbnail 등 그 아래 임의 중첩 URL은 근거로 보지 않는다.
    if (Array.isArray(result.content)) {
      for (const contentEntry of result.content) collectDirect(contentEntry);
    }
  }
  return output;
}

function streamError(code, message, details = '') {
  return new ClaudeCliError(code, message, String(details || '').slice(0, 3000));
}

function requireEmptyArray(init, field, label) {
  const value = init[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 0) {
    throw streamError(
      'SECURITY_POLICY',
      `Claude CLI에서 ${label}이 감지되어 결과를 폐기했습니다.`,
      JSON.stringify(value).slice(0, 1000),
    );
  }
}

function requireArrayWhenPresent(init, field, label) {
  const value = init[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw streamError(
      'BAD_OUTPUT',
      `Claude CLI 시작 이벤트의 ${label} 형식이 올바르지 않습니다.`,
      JSON.stringify(value).slice(0, 1000),
    );
  }
}

function validateInitEvent(event) {
  const initVersion = parseCliVersion(String(event.claude_code_version || ''));
  if (!initVersion || !isMinimumCliVersion(initVersion)) {
    throw streamError(
      'CLI_VERSION',
      '실제 조사 프로세스의 Claude Code 버전을 안전하게 확인하지 못했습니다.',
      `감지된 버전: ${String(event.claude_code_version || '(없음)')}\n필요한 최소 버전: ${MINIMUM_CLI_VERSION.join('.')}`,
    );
  }
  if (!Array.isArray(event.tools)) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 시작 이벤트에 tools 배열이 없습니다.');
  }
  const tools = [...new Set(event.tools.map((tool) => String(tool)))];
  const forbidden = tools.filter((tool) => ![RESEARCH_TOOL, SPECIAL_BUILTIN_TOOL].includes(tool));
  if (!tools.includes(RESEARCH_TOOL)) {
    throw streamError(
      'WEB_SEARCH_UNAVAILABLE',
      'Claude CLI에서 WebSearch 도구를 사용할 수 없습니다.',
      `사용 가능한 도구: ${tools.join(', ') || '(없음)'}`,
    );
  }
  if (forbidden.length > 0) {
    throw streamError(
      'SECURITY_POLICY',
      'WebSearch 외 Claude CLI 도구가 활성화되어 결과를 폐기했습니다.',
      `감지된 도구: ${forbidden.join(', ')}`,
    );
  }
  // Some enterprise hardening forces a requested dontAsk session back to
  // default. --allowedTools still pre-approves WebSearch in default mode; the
  // exact init.tools check above and per-event checks below keep every other
  // tool unavailable and reject permission denials.
  if (!['dontAsk', 'default'].includes(event.permissionMode)) {
    throw streamError(
      'SECURITY_POLICY',
      'Claude CLI가 허용된 권한 모드로 시작되지 않았습니다.',
      `감지된 권한 모드: ${String(event.permissionMode || '(없음)')}`,
    );
  }
  requireEmptyArray(event, 'mcp_servers', 'MCP 서버');
  requireEmptyArray(event, 'mcp_server_errors', 'MCP 서버 구성 오류');
  // Claude Code 2.1.214+ can list installed plugin metadata and the built-in
  // agent names in safe mode even though neither is available as a tool.
  // Their execution is rejected below through exact tool validation, hook
  // events, and parent_tool_use_id checks.
  requireArrayWhenPresent(event, 'plugins', '플러그인 메타데이터');
  requireEmptyArray(event, 'plugin_errors', '플러그인 로드 시도');
  requireEmptyArray(event, 'skills', '스킬');
  requireEmptyArray(event, 'slash_commands', '슬래시 명령');
  requireArrayWhenPresent(event, 'agents', '에이전트 메타데이터');
  requireEmptyArray(event, 'hooks', 'hook');
}

function eventContent(event) {
  const content = event?.message?.content;
  if (content === undefined || content === null || typeof content === 'string') return [];
  if (!Array.isArray(content)) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 메시지 content 형식이 올바르지 않습니다.');
  }
  return content;
}

function validateResultEventMetadata(event) {
  if (
    event.ttft_ms !== undefined
    && (!Number.isFinite(event.ttft_ms) || event.ttft_ms < 0)
  ) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result의 ttft_ms 형식이 올바르지 않습니다.');
  }
  if (
    event.fast_mode_state !== undefined
    && !ALLOWED_FAST_MODE_STATES.has(event.fast_mode_state)
  ) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result의 fast_mode_state 형식이 올바르지 않습니다.');
  }
  if (
    event.terminal_reason !== undefined
    && !ALLOWED_TERMINAL_REASONS.has(event.terminal_reason)
  ) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result의 terminal_reason 형식이 올바르지 않습니다.');
  }
  if (
    event.stop_reason !== undefined
    && event.stop_reason !== null
    && typeof event.stop_reason !== 'string'
  ) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result의 stop_reason 형식이 올바르지 않습니다.');
  }
  if (Object.prototype.hasOwnProperty.call(event, 'origin')) {
    const origin = event.origin;
    if (
      !origin
      || typeof origin !== 'object'
      || Array.isArray(origin)
      || origin.kind !== 'human'
      || Object.keys(origin).some((field) => field !== 'kind')
    ) {
      throw streamError(
        'SECURITY_POLICY',
        '직접 실행이 아닌 Claude CLI 결과 origin이 감지되어 결과를 폐기했습니다.',
        JSON.stringify(origin).slice(0, 1000),
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(event, 'deferred_tool_use')) {
    throw streamError(
      'SECURITY_POLICY',
      'Claude CLI가 연기된 도구 호출을 반환하여 결과를 폐기했습니다.',
      JSON.stringify(event.deferred_tool_use).slice(0, 1000),
    );
  }
  if (event.stop_reason === 'tool_deferred' || event.terminal_reason === 'tool_deferred') {
    throw streamError('SECURITY_POLICY', 'Claude CLI의 연기된 도구 실행 흔적이 감지되었습니다.');
  }
  if (event.subtype === 'success' && event.terminal_reason !== undefined
    && event.terminal_reason !== 'completed') {
    throw streamError(
      'BAD_OUTPUT',
      'Claude CLI 성공 result의 종료 사유가 completed가 아닙니다.',
      event.terminal_reason,
    );
  }
}

function validateRateLimitEvent(event) {
  const unknownFields = Object.keys(event)
    .filter((field) => !ALLOWED_RATE_LIMIT_EVENT_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw streamError(
      'SECURITY_POLICY',
      'Claude CLI rate_limit_event에 허용 목록 밖 필드가 있습니다.',
      unknownFields.join(', '),
    );
  }
  if (typeof event.uuid !== 'string' || !event.uuid.trim()
    || typeof event.session_id !== 'string' || !event.session_id.trim()) {
    throw streamError('BAD_OUTPUT', 'Claude CLI rate_limit_event 식별자 형식이 올바르지 않습니다.');
  }
  const info = event.rate_limit_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw streamError('BAD_OUTPUT', 'Claude CLI rate_limit_info 형식이 올바르지 않습니다.');
  }
  const unknownInfoFields = Object.keys(info)
    .filter((field) => !ALLOWED_RATE_LIMIT_INFO_FIELDS.has(field));
  if (unknownInfoFields.length > 0 || !ALLOWED_RATE_LIMIT_STATUSES.has(info.status)) {
    throw streamError(
      'BAD_OUTPUT',
      'Claude CLI rate_limit_info에 알 수 없는 필드 또는 상태가 있습니다.',
      [...unknownInfoFields, String(info.status || '(상태 없음)')].join(', '),
    );
  }
  for (const field of ['resetsAt', 'utilization']) {
    if (info[field] !== undefined && (!Number.isFinite(info[field]) || info[field] < 0)) {
      throw streamError('BAD_OUTPUT', `Claude CLI rate_limit_info.${field} 형식이 올바르지 않습니다.`);
    }
  }
}

function requireExactEventFields(event, allowedFields, label) {
  const unknownFields = Object.keys(event).filter((field) => !allowedFields.has(field));
  if (unknownFields.length > 0) {
    throw streamError(
      'SECURITY_POLICY',
      `Claude CLI ${label}에 허용 목록 밖 필드가 있습니다.`,
      unknownFields.join(', '),
    );
  }
  if (typeof event.uuid !== 'string' || !event.uuid.trim()
    || typeof event.session_id !== 'string' || !event.session_id.trim()) {
    throw streamError('BAD_OUTPUT', `Claude CLI ${label} 식별자 형식이 올바르지 않습니다.`);
  }
}

function validateCompactBoundaryEvent(event) {
  requireExactEventFields(event, ALLOWED_COMPACT_BOUNDARY_FIELDS, 'compact_boundary 이벤트');
  const metadata = event.compact_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw streamError('BAD_OUTPUT', 'Claude CLI compact_metadata 형식이 올바르지 않습니다.');
  }
  const unknownFields = Object.keys(metadata)
    .filter((field) => !ALLOWED_COMPACT_METADATA_FIELDS.has(field));
  if (unknownFields.length > 0
    || !ALLOWED_COMPACT_TRIGGERS.has(metadata.trigger)
    || !Number.isSafeInteger(metadata.pre_tokens)
    || metadata.pre_tokens < 0) {
    throw streamError(
      'BAD_OUTPUT',
      'Claude CLI compact_metadata에 알 수 없는 필드 또는 값이 있습니다.',
      [...unknownFields, String(metadata.trigger || '(trigger 없음)'), String(metadata.pre_tokens)]
        .join(', '),
    );
  }
}

function validateStatusEvent(event) {
  requireExactEventFields(event, ALLOWED_STATUS_EVENT_FIELDS, 'status 이벤트');
  if (!ALLOWED_STATUS_VALUES.has(event.status)) {
    throw streamError(
      'BAD_OUTPUT',
      'Claude CLI status 이벤트에 알 수 없는 상태가 있습니다.',
      String(event.status ?? '(상태 없음)'),
    );
  }
  if (event.permissionMode !== undefined
    && !['dontAsk', 'default'].includes(event.permissionMode)) {
    throw streamError(
      'SECURITY_POLICY',
      'Claude CLI status 이벤트에서 허용되지 않은 권한 모드가 감지되었습니다.',
      String(event.permissionMode),
    );
  }
}

function validateThinkingTokensEvent(event) {
  requireExactEventFields(event, ALLOWED_THINKING_TOKENS_EVENT_FIELDS, 'thinking_tokens 이벤트');
  if (!Number.isSafeInteger(event.estimated_tokens)
    || event.estimated_tokens < 0
    || !Number.isSafeInteger(event.estimated_tokens_delta)
    || event.estimated_tokens_delta < 0
    || event.estimated_tokens_delta > event.estimated_tokens) {
    throw streamError(
      'BAD_OUTPUT',
      'Claude CLI thinking_tokens 이벤트의 토큰 값이 올바르지 않습니다.',
      `누계: ${String(event.estimated_tokens)}\n증가량: ${String(event.estimated_tokens_delta)}`,
    );
  }
}

function validateKnownStreamEvent(event) {
  if (!ALLOWED_STREAM_EVENT_TYPES.has(event.type)) {
    throw streamError(
      'SECURITY_POLICY',
      '허용 목록에 없는 Claude CLI top-level 이벤트가 감지되었습니다.',
      String(event.type || '(형식 없음)'),
    );
  }
  if (event.type === 'system') {
    if (!ALLOWED_SYSTEM_EVENT_SUBTYPES.has(event.subtype)) {
      throw streamError(
        'SECURITY_POLICY',
        '허용 목록에 없는 Claude CLI system subtype이 감지되었습니다.',
        String(event.subtype || '(없음)'),
      );
    }
    if (event.subtype === 'compact_boundary') validateCompactBoundaryEvent(event);
    if (event.subtype === 'status') validateStatusEvent(event);
    if (event.subtype === 'thinking_tokens') validateThinkingTokensEvent(event);
    return;
  }
  if (event.type === 'result') {
    if (!ALLOWED_RESULT_EVENT_SUBTYPES.has(event.subtype)) {
      throw streamError(
        'SECURITY_POLICY',
        '허용 목록에 없는 Claude CLI result subtype이 감지되었습니다.',
        String(event.subtype || '(없음)'),
      );
    }
    const unknownFields = Object.keys(event)
      .filter((field) => !ALLOWED_RESULT_EVENT_FIELDS.has(field));
    if (unknownFields.length > 0) {
      throw streamError(
        'SECURITY_POLICY',
        'Claude CLI 최종 result에 허용 목록 밖 필드가 감지되어 결과를 폐기했습니다.',
        unknownFields.join(', '),
      );
    }
    validateResultEventMetadata(event);
    return;
  }
  if (event.type === 'rate_limit_event') {
    validateRateLimitEvent(event);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(event, 'subtype')) {
    throw streamError(
      'SECURITY_POLICY',
      'subtype을 사용하지 않는 Claude CLI 이벤트에 subtype이 포함되었습니다.',
      `${event.type}/${String(event.subtype || '(없음)')}`,
    );
  }
}

function validateKnownContentBlock(block, role) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    throw streamError('BAD_OUTPUT', `Claude ${role} content block 형식이 올바르지 않습니다.`);
  }
  const type = typeof block.type === 'string' ? block.type : '';
  const allowed = role === 'assistant'
    ? ALLOWED_ASSISTANT_CONTENT_BLOCK_TYPES
    : ALLOWED_USER_CONTENT_BLOCK_TYPES;
  if (!allowed.has(type)) {
    throw streamError(
      'SECURITY_POLICY',
      `허용 목록에 없는 Claude ${role} content block이 감지되었습니다.`,
      `${type || '(형식 없음)'}${block.name ? `: ${String(block.name)}` : ''}`,
    );
  }
}

function resultIsError(event, block) {
  if (block?.is_error === true) return true;
  if (event?.tool_use_result && typeof event.tool_use_result === 'object') {
    if (event.tool_use_result.is_error === true) return true;
    if (event.tool_use_result.status === 'error') return true;
  }
  return false;
}

function resultErrorDetails(event, block) {
  const values = [block?.content, event?.tool_use_result];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 1000);
    if (value && typeof value === 'object') {
      try { return JSON.stringify(value).slice(0, 1000); } catch {}
    }
  }
  return '세부 오류 없음';
}

function normalizeSearchQuery(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const MEANINGFUL_NUMERIC_CONTEXT = new Set([
  'article', 'cfr', 'chapter', 'ear', 'eo', 'heading', 'hs', 'hts', 'htsus',
  'order', 'part', 'proclamation', 'regulation', 'rule', 'section', 'title', 'usc',
]);
const LEADING_NUMERIC_CONTEXT = new Set(['cfr', 'usc']);
const DECORATIVE_NUMERIC_PREFIX = new Set([
  'attempt', 'query', 'run', 'search', 'try', '검색', '시도', '조사', '질의',
]);

function expandFingerprintToken(token) {
  const wrappedContext = token.match(/^(\d+)(\p{L}+)(\d+)$/u);
  if (wrappedContext && LEADING_NUMERIC_CONTEXT.has(wrappedContext[2])) {
    return wrappedContext.slice(1);
  }

  const suffixedNumber = token.match(/^(\p{L}+)(\d+)$/u);
  if (
    suffixedNumber
    && (
      MEANINGFUL_NUMERIC_CONTEXT.has(suffixedNumber[1])
      || DECORATIVE_NUMERIC_PREFIX.has(suffixedNumber[1])
    )
  ) {
    return suffixedNumber.slice(1);
  }
  return [token];
}

export function searchQueryFingerprint(value) {
  const normalized = normalizeSearchQuery(value);
  if (!normalized) return '';
  const tokens = normalized.split(' ').flatMap(expandFingerprintToken);
  const preservedNumericIndexes = new Set();

  tokens.forEach((token, index) => {
    if (!MEANINGFUL_NUMERIC_CONTEXT.has(token)) return;

    if (LEADING_NUMERIC_CONTEXT.has(token)) {
      for (let cursor = index - 1; cursor >= 0 && /^\d+$/.test(tokens[cursor]); cursor -= 1) {
        preservedNumericIndexes.add(cursor);
      }
    }
    for (let cursor = index + 1; cursor < tokens.length && /^\d+$/.test(tokens[cursor]); cursor += 1) {
      preservedNumericIndexes.add(cursor);
    }
  });

  const semanticTokens = tokens.filter((token, index) => (
    !/^\d+$/.test(token)
    || preservedNumericIndexes.has(index)
  ));
  const uniqueTokens = [...new Set(semanticTokens)];
  return uniqueTokens.sort().join(' ');
}

function webSearchDomains(input, key) {
  if (input?.[key] === undefined) return [];
  if (!Array.isArray(input[key])) {
    throw streamError('BAD_OUTPUT', `Claude WebSearch ${key} 형식이 배열이 아닙니다.`);
  }
  const domains = [];
  for (const raw of input[key]) {
    const hostname = publicHostname(raw);
    if (!hostname) {
      throw streamError(
        'BAD_OUTPUT',
        `Claude WebSearch ${key}에 공개 hostname이 아닌 값이 있습니다.`,
        String(raw || '').trim().slice(0, 500),
      );
    }
    if (!domains.includes(hostname)) domains.push(hostname);
  }
  return domains;
}

function webSearchRequest(block, officialDomainAllowlist = [], strictSearchPolicy = false) {
  const input = block?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw streamError('BAD_OUTPUT', 'Claude WebSearch 입력 형식이 올바르지 않습니다.');
  }
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    throw streamError('BAD_OUTPUT', 'Claude WebSearch 입력에 query가 없습니다.');
  }
  const allowedDomains = webSearchDomains(input, 'allowed_domains');
  const blockedDomains = webSearchDomains(input, 'blocked_domains');
  if (allowedDomains.length > 0 && blockedDomains.length > 0) {
    throw streamError(
      'BAD_OUTPUT',
      'Claude WebSearch는 allowed_domains와 blocked_domains를 함께 사용할 수 없습니다.',
    );
  }
  if (strictSearchPolicy && blockedDomains.length > 0) {
    throw streamError(
      'BAD_OUTPUT',
      '엄격 검색 모드에서는 blocked_domains WebSearch를 사용할 수 없습니다.',
      blockedDomains.join(', '),
    );
  }
  const untrustedDomains = allowedDomains.filter(
    (hostname) => !isTrustedOfficialDomain(hostname, officialDomainAllowlist),
  );
  if (officialDomainAllowlist.length > 0 && untrustedDomains.length > 0) {
    throw streamError(
      'BAD_OUTPUT',
      'Claude WebSearch 공식기관 검색에 신뢰 목록 밖 도메인이 포함되었습니다.',
      untrustedDomains.join(', '),
    );
  }
  return {
    query,
    normalizedQuery,
    allowedDomains,
    blockedDomains,
    mode: allowedDomains.length > 0
      ? 'official'
      : (blockedDomains.length > 0 ? 'blocked' : 'broad'),
  };
}

function inspectWebSearchResult(event, block, search) {
  if (resultIsError(event, block)) {
    return { error: resultErrorDetails(event, block), urls: [], officialUrls: [] };
  }
  const value = event?.tool_use_result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '구조화된 WebSearch 결과가 없습니다.', urls: [], officialUrls: [] };
  }
  if (typeof value.query !== 'string' || !value.query.trim()) {
    return { error: 'WebSearch 결과에 실행된 query가 없습니다.', urls: [], officialUrls: [] };
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    return { error: 'WebSearch results가 비어 있습니다.', urls: [], officialUrls: [] };
  }
  if (value.searchCount !== undefined
    && (!Number.isSafeInteger(value.searchCount) || value.searchCount < 1)) {
    return {
      error: `WebSearch searchCount가 올바르지 않습니다: ${String(value.searchCount)}`,
      urls: [],
      officialUrls: [],
    };
  }
  const urls = collectStructuredResultUrls(value);
  if (urls.length === 0) {
    return { error: 'WebSearch 실제 검색 결과에 공개 HTTPS URL이 없습니다.', urls, officialUrls: [] };
  }
  const officialUrls = search.mode === 'official'
    ? urls.filter((url) => isTrustedOfficialDomain(new URL(url).hostname, search.allowedDomains))
    : [];
  if (search.mode === 'official' && officialUrls.length === 0) {
    return {
      error: 'WebSearch 공식기관 검색 결과 URL이 요청한 allowed_domains와 일치하지 않습니다.',
      urls,
      officialUrls,
    };
  }
  return { error: '', urls, officialUrls };
}

function isUnexpectedToolBlock(block) {
  const type = String(block?.type || '');
  return type !== 'tool_use' && /tool/i.test(type);
}

function isSuspiciousRuntimeFamily(value) {
  const normalized = String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return /(?:^|[\s_-])(?:tools?|files?|persist(?:ed|ence|ent|ing)?|background|tasks?|memory|agent|shell|command|write|edit|hook|plugin|mcp|skill)(?:[\s_-]|$)/i
    .test(normalized);
}

function classifyResultFailure(event) {
  if (event.subtype === 'error_max_turns') return 'TURN_LIMIT';
  if (event.subtype === 'error_max_budget_usd') return 'BUDGET_LIMIT';
  const errors = Array.isArray(event.errors) ? event.errors.map(String) : [];
  const apiStatus = Number.isSafeInteger(event.api_error_status)
    ? event.api_error_status
    : undefined;
  const indicators = [
    ...errors,
    typeof event.result === 'string' ? event.result : '',
    typeof event.error === 'string' ? event.error : '',
    typeof event.terminal_reason === 'string' ? event.terminal_reason : '',
    apiStatus === undefined ? '' : String(apiStatus),
  ].filter(Boolean);
  return classifyError(indicators.join('\n'), apiStatus);
}

export function mergeClaudeStreamError(error, result = {}) {
  if (!(error instanceof ClaudeCliError)) return error;
  const stderr = String(result.stderr || '').trim();
  let code = error.code;
  if (
    code === 'BAD_OUTPUT'
    && (result.exitCode !== 0 || result.signalCode)
    && stderr
  ) {
    const classified = classifyError(stderr, result.exitCode);
    if (classified !== 'CLI_EXIT') code = classified;
  }

  const detailParts = [];
  if (code !== error.code) {
    detailParts.push(`stream-json 파싱 오류: ${error.message}`);
  }
  if (error.details) detailParts.push(String(error.details).slice(0, 1400));
  if (stderr) detailParts.push(`stderr: ${stderr.slice(0, 1400)}`);
  if (code === error.code && detailParts.join('\n') === String(error.details || '')) return error;
  return new ClaudeCliError(
    code,
    code === error.code ? error.message : `Claude CLI를 완료하지 못했습니다(${code}).`,
    detailParts.join('\n').slice(0, 3000),
  );
}

export function parseClaudeStream(output, options = {}) {
  const officialDomainAllowlist = options.officialDomainAllowlist === undefined
    ? []
    : webSearchDomains(
      { allowed_domains: options.officialDomainAllowlist },
      'allowed_domains',
    );
  if (options.requireOfficialAndBroadSearch === true && officialDomainAllowlist.length === 0) {
    throw streamError('CONFIG', '공식기관 검색의 신뢰 도메인 목록이 비어 있습니다.');
  }
  const text = String(output || '');
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw streamError('BAD_OUTPUT', 'Claude CLI가 stream-json 출력을 반환하지 않았습니다.');
  }
  if (lines.length > MAX_STREAM_EVENTS) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 이벤트 수가 허용 범위를 초과했습니다.');
  }

  let init = null;
  let finalResult = null;
  const searches = new Map();
  const groundingUrls = [];
  const urlSet = new Set();
  const warnings = [];
  let eventIndex = 0;
  let streamSessionId = null;

  for (const line of lines) {
    eventIndex += 1;
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
      throw streamError('BAD_OUTPUT', `Claude CLI JSONL ${eventIndex}번째 줄이 허용 크기를 초과했습니다.`);
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw streamError(
        'BAD_OUTPUT',
        `Claude CLI JSONL ${eventIndex}번째 줄을 읽지 못했습니다.`,
        `${error.message}\n${line.slice(0, 500)}`,
      );
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw streamError('BAD_OUTPUT', `Claude CLI JSONL ${eventIndex}번째 이벤트 형식이 올바르지 않습니다.`);
    }
    if (Object.prototype.hasOwnProperty.call(event, 'session_id')) {
      if (typeof event.session_id !== 'string' || !event.session_id.trim()) {
        throw streamError('BAD_OUTPUT', 'Claude CLI 이벤트의 session_id 형식이 올바르지 않습니다.');
      }
      if (streamSessionId && event.session_id !== streamSessionId) {
        throw streamError(
          'SECURITY_POLICY',
          'Claude CLI stream-json에서 서로 다른 session_id가 감지되었습니다.',
          `기대: ${streamSessionId}\n감지: ${event.session_id}`,
        );
      }
      streamSessionId = event.session_id;
    }
    if (
      /^hook_/.test(String(event.type))
      || (event.type === 'system' && /^hook_/.test(String(event.subtype)))
    ) {
      throw streamError(
        'SECURITY_POLICY',
        'Claude CLI hook 실행이 감지되어 결과를 폐기했습니다.',
        `${event.hook_event || ''} ${event.hook_name || ''}`.trim(),
      );
    }
    validateKnownStreamEvent(event);
    if (finalResult) {
      throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result 뒤에 추가 이벤트가 있습니다.');
    }

    if (event.type === 'system' && event.subtype === 'init') {
      if (init || eventIndex !== 1) {
        throw streamError('BAD_OUTPUT', 'Claude CLI 시작 이벤트의 위치 또는 개수가 올바르지 않습니다.');
      }
      validateInitEvent(event);
      init = event;
      continue;
    }
    if (!init) {
      throw streamError('SECURITY_POLICY', 'Claude CLI 시작 검증 전에 다른 이벤트가 실행되었습니다.');
    }

    if (event.type === 'system' && event.subtype === 'plugin_install') {
      throw streamError('SECURITY_POLICY', 'Claude CLI 플러그인 설치 이벤트가 감지되어 결과를 폐기했습니다.');
    }
    if (event.type === 'system' && event.subtype === 'api_retry') {
      warnings.push(`Claude API 재시도 ${metric(event.attempt)}/${metric(event.max_retries)}`);
      continue;
    }
    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'status') {
      if (event.permissionMode !== undefined && event.permissionMode !== init.permissionMode) {
        throw streamError(
          'SECURITY_POLICY',
          'Claude CLI 실행 중 권한 모드가 변경되었습니다.',
          `시작: ${init.permissionMode}\n상태 이벤트: ${event.permissionMode}`,
        );
      }
      continue;
    }
    if (event.type === 'system' && event.subtype === 'thinking_tokens') {
      continue;
    }
    if (event.type === 'rate_limit_event') {
      const { status, resetsAt, utilization } = event.rate_limit_info;
      if (status === 'rejected') {
        throw streamError(
          'RATE_LIMIT',
          'Claude CLI 사용량 제한으로 조사가 거부되었습니다.',
          `resetsAt=${resetsAt ?? '(없음)'}, utilization=${utilization ?? '(없음)'}`,
        );
      }
      if (status === 'allowed_warning') {
        warnings.push(
          `Claude 사용량 제한 경고: resetsAt=${resetsAt ?? '(없음)'}, `
          + `utilization=${utilization ?? '(없음)'}`,
        );
      }
      continue;
    }
    if (event.type === 'system' && /^(?:task_|files_persisted|memory_)/.test(String(event.subtype))) {
      throw streamError('SECURITY_POLICY', '허용되지 않은 Claude 백그라운드 또는 저장 이벤트가 감지되었습니다.');
    }
    if (isSuspiciousRuntimeFamily(event.subtype)) {
      throw streamError(
        'SECURITY_POLICY',
        '알려지지 않은 Claude 도구·파일·저장·백그라운드 하위 이벤트가 감지되었습니다.',
        String(event.subtype),
      );
    }
    if (event.type === 'tool_progress') {
      if (event.tool_name !== RESEARCH_TOOL || event.parent_tool_use_id) {
        throw streamError(
          'SECURITY_POLICY',
          '허용되지 않은 Claude 도구 진행 이벤트가 감지되었습니다.',
          String(event.tool_name || '(이름 없음)'),
        );
      }
      continue;
    }
    if (event.type === 'assistant') {
      if (event.parent_tool_use_id) {
        throw streamError('SECURITY_POLICY', 'Claude 하위 에이전트 메시지가 감지되어 결과를 폐기했습니다.');
      }
      for (const block of eventContent(event)) {
        validateKnownContentBlock(block, 'assistant');
        if (isUnexpectedToolBlock(block)) {
          throw streamError(
            'SECURITY_POLICY',
            '허용되지 않은 Claude 서버 또는 확장 도구 블록이 감지되어 결과를 폐기했습니다.',
            `${String(block.type || '(형식 없음)')}: ${String(block.name || '(이름 없음)')}`,
          );
        }
        if (block.type !== 'tool_use' && isSuspiciousRuntimeFamily(block.type)) {
          throw streamError(
            'SECURITY_POLICY',
            '알려지지 않은 Claude 파일·저장·백그라운드 블록이 감지되었습니다.',
            String(block.type || '(형식 없음)'),
          );
        }
        if (block.type !== 'tool_use') continue;
        const name = String(block.name || '');
        const id = String(block.id || '');
        if (name !== RESEARCH_TOOL) {
          throw streamError(
            'SECURITY_POLICY',
            '허용되지 않은 Claude CLI 도구 호출이 감지되어 결과를 폐기했습니다.',
            `감지된 도구: ${name || '(이름 없음)'}`,
          );
        }
        if (!id || searches.has(id)) {
          throw streamError('BAD_OUTPUT', 'Claude WebSearch tool_use ID가 없거나 중복되었습니다.');
        }
        searches.set(id, {
          status: 'pending',
          ...webSearchRequest(
            block,
            officialDomainAllowlist,
            options.requireOfficialAndBroadSearch === true,
          ),
        });
      }
      continue;
    }
    if (event.type === 'user') {
      if (event.parent_tool_use_id) {
        throw streamError('SECURITY_POLICY', 'Claude 하위 에이전트 도구 결과가 감지되어 결과를 폐기했습니다.');
      }
      for (const block of eventContent(event)) {
        validateKnownContentBlock(block, 'user');
        if (block.type !== 'tool_result' && /tool/i.test(String(block.type || ''))) {
          throw streamError(
            'SECURITY_POLICY',
            '허용되지 않은 Claude 서버 또는 확장 도구 결과가 감지되어 결과를 폐기했습니다.',
            String(block.type || '(형식 없음)'),
          );
        }
        if (block.type !== 'tool_result' && isSuspiciousRuntimeFamily(block.type)) {
          throw streamError(
            'SECURITY_POLICY',
            '알려지지 않은 Claude 파일·저장·백그라운드 결과 블록이 감지되었습니다.',
            String(block.type || '(형식 없음)'),
          );
        }
        if (block.type !== 'tool_result') continue;
        const id = String(block.tool_use_id || '');
        const search = searches.get(id);
        if (!id || !search) {
          throw streamError('BAD_OUTPUT', '대응하는 WebSearch 요청이 없는 tool_result가 감지되었습니다.', id);
        }
        if (search.status !== 'pending') {
          throw streamError('BAD_OUTPUT', '동일한 WebSearch tool_result가 중복되었습니다.', id);
        }
        const resultQuery = event?.tool_use_result?.query;
        if (
          typeof resultQuery === 'string'
          && normalizeSearchQuery(resultQuery) !== search.normalizedQuery
        ) {
          throw streamError(
            'BAD_OUTPUT',
            'Claude WebSearch 요청과 결과의 query가 일치하지 않습니다.',
            `요청: ${search.query}\n결과: ${resultQuery}`,
          );
        }
        const inspected = inspectWebSearchResult(event, block, search);
        if (inspected.error) {
          search.status = 'failed';
          search.resultUrls = [];
          search.officialResultUrls = [];
          warnings.push(`WebSearch 실패: ${inspected.error}`);
        } else {
          search.status = 'success';
          search.resultUrls = inspected.urls;
          search.officialResultUrls = inspected.officialUrls;
          for (const url of inspected.urls) {
            if (!urlSet.has(url) && groundingUrls.length < MAX_GROUNDING_URLS) {
              urlSet.add(url);
              groundingUrls.push(url);
            }
          }
        }
      }
      continue;
    }
    if (event.type === 'result') {
      finalResult = event;
      continue;
    }
    if (isSuspiciousRuntimeFamily(`${event.type} ${event.subtype || ''}`)) {
      throw streamError(
        'SECURITY_POLICY',
        '알려지지 않은 Claude 도구·파일·저장·백그라운드 이벤트가 감지되었습니다.',
        `${event.type}${event.subtype ? `/${event.subtype}` : ''}`,
      );
    }
  }

  if (!init) throw streamError('BAD_OUTPUT', 'Claude CLI 시작 이벤트가 없습니다.');
  if (!finalResult) throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result 이벤트가 없습니다.');

  const pending = [...searches.entries()].filter(([, value]) => value.status === 'pending');
  if (pending.length > 0) {
    throw streamError(
      'BAD_OUTPUT',
      '결과가 확인되지 않은 WebSearch 호출이 있습니다.',
      pending.map(([id]) => id).join(', '),
    );
  }

  if (finalResult.subtype !== 'success' || finalResult.is_error !== false) {
    const errors = Array.isArray(finalResult.errors) ? finalResult.errors.map(String) : [];
    const detail = errors.join('\n') || JSON.stringify(finalResult).slice(0, 2000);
    const code = classifyResultFailure(finalResult);
    throw streamError(code, `Claude CLI가 조사를 완료하지 못했습니다.(${code})`, detail);
  }
  if (typeof finalResult.result !== 'string' || !finalResult.result.trim()) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result에 응답 문자열이 없습니다.');
  }
  if (!Array.isArray(finalResult.permission_denials)) {
    throw streamError('BAD_OUTPUT', 'Claude CLI 최종 result의 permission_denials 형식이 올바르지 않습니다.');
  }
  if (finalResult.permission_denials.length > 0) {
    throw streamError(
      'POLICY',
      'Claude CLI 도구 권한 거부가 감지되어 결과를 폐기했습니다.',
      JSON.stringify(finalResult.permission_denials),
    );
  }

  const successfulSearches = [...searches.values()].filter((value) => value.status === 'success');
  const success = successfulSearches.length;
  const fail = [...searches.values()].filter((value) => value.status === 'failed').length;
  const minimum = positiveInt(options.minimumWebSearchSuccesses, 1, 200);
  if (success < minimum) {
    const code = fail > 0 ? 'SEARCH_FAILED' : 'SEARCH_NOT_RUN';
    throw streamError(
      code,
      'Claude CLI에서 성공한 WebSearch 실행을 확인하지 못했습니다.',
      [`성공 ${success}회, 실패 ${fail}회`, ...warnings].join('\n'),
    );
  }
  const distinctQueries = new Set(
    successfulSearches
      .map((value) => searchQueryFingerprint(value.normalizedQuery))
      .filter(Boolean),
  );
  const official = successfulSearches.filter((value) => value.mode === 'official').length;
  const broad = successfulSearches.filter((value) => value.mode === 'broad').length;
  const minimumOfficial = positiveInt(options.minimumOfficialSearches, 1, 200);
  const minimumBroad = positiveInt(options.minimumBroadSearches, 1, 200);
  const minimumDistinct = Math.max(minimum, minimumOfficial + minimumBroad);
  if (options.requireOfficialAndBroadSearch === true && (
    distinctQueries.size < minimumDistinct
    || official < minimumOfficial
    || broad < minimumBroad
  )) {
    throw streamError(
      'SEARCH_INCOMPLETE',
      '필수 다각도 공식기관 검색과 일반 동향 검색을 모두 확인하지 못했습니다.',
      `서로 다른 query ${distinctQueries.size}개(최소 ${minimumDistinct}개), `
      + `공식기관 검색 ${official}회(최소 ${minimumOfficial}회), `
      + `일반 동향 검색 ${broad}회(최소 ${minimumBroad}회)`,
    );
  }

  const toolEvidence = {
    available: true,
    totalCalls: searches.size,
    totalSuccess: success,
    totalFail: fail,
    byName: {
      WebSearch: {
        count: searches.size,
        success,
        fail,
        official,
        broad,
        queries: successfulSearches.map((value) => ({
          query: value.query,
          mode: value.mode,
          allowedDomains: value.allowedDomains,
        })),
      },
    },
  };
  const groundingSearches = [...searches.entries()]
    .filter(([, search]) => search.status === 'success')
    .map(([toolUseId, search]) => ({
      toolUseId,
      query: search.query,
      mode: search.mode,
      allowedDomains: [...search.allowedDomains],
      blockedDomains: [...search.blockedDomains],
      urls: [...search.resultUrls],
      officialUrls: [...search.officialResultUrls],
    }));
  return {
    response: finalResult.result,
    evidenceKind: 'direct',
    stats: {
      durationMs: metric(finalResult.duration_ms),
      durationApiMs: metric(finalResult.duration_api_ms),
      numTurns: metric(finalResult.num_turns),
      totalCostUsd: Number.isFinite(finalResult.total_cost_usd) ? finalResult.total_cost_usd : null,
      usage: finalResult.usage && typeof finalResult.usage === 'object' ? finalResult.usage : null,
      modelUsage: finalResult.modelUsage && typeof finalResult.modelUsage === 'object'
        ? finalResult.modelUsage
        : null,
    },
    warnings: normalizeWarnings(warnings),
    toolEvidence,
    groundingUrls,
    groundingSearches,
    sessionId: streamSessionId,
  };
}

export function parseCliVersion(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:claude(?:\s+code)?\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?(?:\s+\(Claude Code\))?\s*$/i,
    );
    if (!match) continue;
    const parts = match.slice(1, 4).map((value) => Number.parseInt(value, 10));
    if (parts.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;
    return { parts, prerelease: match[4] || '' };
  }
  return null;
}

function isMinimumCliVersion(version) {
  for (let index = 0; index < MINIMUM_CLI_VERSION.length; index += 1) {
    if (version.parts[index] > MINIMUM_CLI_VERSION[index]) return true;
    if (version.parts[index] < MINIMUM_CLI_VERSION[index]) return false;
  }
  return !version.prerelease;
}

export async function preflightClaudeCli(options = {}) {
  const cwd = await verifyResearchWorkspace(options.cwd);
  const timeout = positiveInt(
    options.timeoutMs,
    preflightTimeoutMs(),
    MAX_PREFLIGHT_TIMEOUT_MS,
  );
  const result = await executeCli(['--version'], {
    cwd,
    signal: options.signal,
    timeoutMs: timeout,
    timeoutCode: 'CLI_STARTUP_TIMEOUT',
    timeoutMessage: `Claude CLI 시작 확인이 ${Math.max(1, Math.round(timeout / 1000))}초 안에 끝나지 않았습니다.`,
  });
  await verifyResearchWorkspace(cwd);
  if (result.exitCode !== 0) throw exitFailure(result, 'Claude CLI 사전 점검 오류');

  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  const version = parseCliVersion(versionOutput);
  if (!version) {
    throw new ClaudeCliError(
      'CLI_VERSION',
      '설치된 Claude CLI의 버전을 확인하지 못했습니다.',
      `버전 출력: ${versionOutput.slice(0, 1000) || '(출력 없음)'}`,
    );
  }
  const versionText = `${version.parts.join('.')}${version.prerelease}`;
  if (!isMinimumCliVersion(version)) {
    throw new ClaudeCliError(
      'CLI_VERSION',
      '설치된 Claude CLI가 안전한 자동 조사에 필요한 최소 버전보다 낮습니다.',
      `감지된 버전: ${versionText}\n필요한 최소 버전: ${MINIMUM_CLI_VERSION.join('.')}`,
    );
  }
  const inheritedSensitiveEnvironmentNames = sensitiveEnvironmentVariableNames(enterpriseEnvironment());
  return {
    version: versionText,
    minimumVersion: MINIMUM_CLI_VERSION.join('.'),
    executablePath: result.executablePath,
    diagnostics: {
      inheritedSensitiveEnvironmentNames,
      executableVerification: result.executableVerification,
      warnings: inheritedSensitiveEnvironmentNames.length > 0
        ? ['Claude CLI에 인증·라우팅 관련 환경변수가 상속됩니다. 진단에는 이름만 표시하며 값은 표시하지 않습니다.']
        : [],
    },
  };
}

export async function callClaudeCli(prompt, options = {}) {
  const cwd = await verifyResearchWorkspace(options.cwd);
  const timeout = positiveInt(options.timeoutMs, timeoutMs(), 1800000);
  const result = await executeCli(researchArguments(), {
    cwd,
    signal: options.signal,
    timeoutMs: timeout,
    input: prompt,
    heartbeat: true,
  });
  await verifyResearchWorkspace(cwd);

  let envelope;
  try {
    envelope = parseClaudeStream(result.stdout, options);
  } catch (error) {
    if (error instanceof ClaudeCliError && result.stdout.trim()) {
      throw mergeClaudeStreamError(error, result);
    }
    if (result.exitCode !== 0 || result.signalCode) throw exitFailure(result, 'Claude CLI 오류');
    throw mergeClaudeStreamError(error, result);
  }
  if (result.exitCode !== 0 || result.signalCode) throw exitFailure(result, 'Claude CLI 오류');
  return envelope;
}
