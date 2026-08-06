import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASKKILL_CAPTURE_BYTES = 64 * 1024;
const MAX_STREAM_EVENTS = 20000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60000;
const MAX_PREFLIGHT_TIMEOUT_MS = 300000;
const MINIMUM_CLI_VERSION = [2, 1, 214];
const RESEARCH_TOOL = 'WebSearch';
const SPECIAL_BUILTIN_TOOL = 'EndConversation';
const FIXED_PROMPT = [
  'Follow the complete task provided on standard input.',
  'Use WebSearch for evidence and return only the requested JSON object.',
].join(' ');
const activeChildren = new Set();
const stoppingChildren = new WeakMap();
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
  return bin;
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
  if (path.isAbsolute(bin) && !await fileExists(bin)) {
    throw new ClaudeCliError('CLI_NOT_FOUND', `Claude CLI 실행 파일을 찾을 수 없습니다: ${bin}`);
  }
  return bin;
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
  return positiveInt(process.env.CLAUDE_CLI_MAX_TURNS, 20, 50);
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
  if (process.platform !== 'win32') {
    return { command: bin, args, windowsVerbatimArguments: false };
  }

  const extension = path.extname(bin).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    return { command: bin, args, windowsVerbatimArguments: false };
  }

  const commandLine = [
    quoteCmdToken(bin, 'CLAUDE_CLI_BIN'),
    ...args.map((arg) => quoteCmdToken(arg, 'Claude CLI 인자')),
  ].join(' ');
  return {
    command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/q', '/v:off', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
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
  return real;
}

function waitForChildClose(child, waitMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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
    if (child.exitCode !== null || child.signalCode !== null) done(true);
  });
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
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
      resolve({ code, details: `${output || fallback}${suffix}`.trim() });
    };
    confirmationTimer = setTimeout(() => {
      done(null, 'taskkill 종료 명령이 10초 안에 끝나지 않아 중단했습니다.');
    }, 12000);
    stopTimer = setTimeout(() => {
      timedOut = true;
      try { killer.kill('SIGKILL'); } catch {}
    }, 10000);
    stopTimer.unref?.();
    confirmationTimer.unref?.();
    killer.once('error', (error) => done(null, error.message));
    killer.once('close', (code, signal) => {
      if (timedOut) {
        done(null, 'taskkill 종료 명령이 10초 안에 끝나지 않아 중단했습니다.');
        return;
      }
      done(code, signal ? `taskkill이 ${signal} 신호로 종료됨` : '');
    });
  });
}

function stopProcessTree(child) {
  if (!child) {
    return Promise.resolve({ closed: true, treeConfirmed: true, details: '' });
  }
  const existing = stoppingChildren.get(child);
  if (existing) return existing;
  if (child.exitCode !== null || child.signalCode !== null) {
    const windowsTreeUnconfirmed = process.platform === 'win32' && Number.isSafeInteger(child.pid);
    return Promise.resolve({
      closed: true,
      treeConfirmed: !windowsTreeUnconfirmed,
      details: windowsTreeUnconfirmed
        ? '부모 프로세스가 먼저 종료되어 Windows 자식 프로세스 트리 종료를 확인할 수 없습니다.'
        : '',
    });
  }

  const stopping = (async () => {
    let treeConfirmed = true;
    let details = '';
    if (process.platform === 'win32' && child.pid) {
      const killed = await runTaskkill(child.pid);
      treeConfirmed = killed.code === 0;
      details = killed.details || (treeConfirmed ? '' : `taskkill 종료 코드 ${killed.code}`);
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }

    let closed = await waitForChildClose(child, 7000);
    if (!closed && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
      closed = await waitForChildClose(child, 1500);
      if (process.platform === 'win32') treeConfirmed = false;
    }
    return { closed, treeConfirmed, details };
  })();
  stoppingChildren.set(child, stopping);
  return stopping;
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
    'Claude 프로세스 트리 종료를 확인하지 못해 실행을 중단했습니다.',
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
    const pid = children[index]?.pid ?? null;
    if (status.status === 'rejected') {
      return {
        pid,
        closed: false,
        treeConfirmed: false,
        details: `프로세스 정리 중 오류: ${status.reason?.message || String(status.reason)}`,
      };
    }
    return { pid, ...status.value };
  });
  for (const status of processes) {
    if (!status.closed || !status.treeConfirmed) {
      console.warn(
        `Claude 프로세스 트리 종료 실패(PID ${status.pid ?? '확인 불가'}): ${status.details || '완전한 종료를 확인하지 못했습니다.'}`,
      );
    }
  }
  return { ok: processes.every((status) => status.closed && status.treeConfirmed), processes };
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
  return positiveInt(process.env.CLAUDE_RUN_TIMEOUT_MS, 2700000, 14400000);
}

function signalError(signal) {
  const reason = signal?.reason;
  return reason?.code === 'RUN_TIMEOUT'
    ? new ClaudeCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
    : new ClaudeCliError('ABORTED', '사용자가 실행을 중단했습니다.');
}

async function executeCli(args, options = {}) {
  const timeout = positiveInt(options.timeoutMs, DEFAULT_PREFLIGHT_TIMEOUT_MS, 1800000);
  const spec = await launchSpec(args);

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(signalError(options.signal));
      return;
    }

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: enterpriseEnvironment(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : classifyError(error?.message);
      reject(new ClaudeCliError(code, `Claude CLI를 실행하지 못했습니다: ${error.message}`));
      return;
    }

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
      activeChildren.delete(child);
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
        || `Claude 응답이 ${Math.max(1, Math.round(timeout / 60000))}분 안에 끝나지 않았습니다.`;
      void forceStop(new ClaudeCliError(options.timeoutCode || 'TIMEOUT', timeoutMessage));
    }, timeout);

    if (options.heartbeat) {
      heartbeat = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ... Claude 조사 중 (${seconds}초 경과)`);
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
        void forceStop(new ClaudeCliError('BAD_OUTPUT', 'Claude CLI 출력이 허용 크기를 초과했습니다.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!stderrCapture.append(chunk)) {
        void forceStop(new ClaudeCliError('BAD_OUTPUT', 'Claude CLI 오류 출력이 허용 크기를 초과했습니다.'));
      }
    });
    child.stdin.on('error', (error) => {
      if (!forcedError && !['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error?.code)) {
        void forceStop(new ClaudeCliError('CLI_EXIT', `Claude CLI 입력 전달 오류: ${error.message}`));
      }
    });
    child.on('error', (error) => {
      if (forcedError) return;
      const code = error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : classifyError(error.message);
      finish(() => reject(new ClaudeCliError(code, `Claude CLI 실행 오류: ${error.message}`)));
    });
    child.on('close', (exitCode, signalCode) => {
      if (forcedError) return;
      finish(() => {
        try {
          resolve({
            stdout: stdoutCapture.text('Claude CLI 표준 출력'),
            stderr: stderrCapture.text('Claude CLI 오류 출력'),
            exitCode,
            signalCode,
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

function safeEvidenceUrl(value) {
  let raw = String(value || '').trim();
  raw = raw.replace(/[),.;:!?\]}]+$/g, '');
  if (!raw || raw.length > 4096) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password || !parsed.hostname) return '';
    if (parsed.port && parsed.port !== '443') return '';
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (
      isIP(hostname)
      || !hostname.includes('.')
      || hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.lan')
      || hostname.endsWith('.test')
      || hostname.endsWith('.invalid')
      || hostname.endsWith('.example')
      || hostname.endsWith('.onion')
    ) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

function collectUrls(value, output, seen = new Set(), depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const matches = value.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
    for (const match of matches) {
      const url = safeEvidenceUrl(match);
      if (url && !seen.has(url) && output.length < 500) {
        seen.add(url);
        output.push(url);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output, seen, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value)) collectUrls(nested, output, seen, depth + 1);
  }
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
  if (event.permissionMode !== 'dontAsk') {
    throw streamError(
      'SECURITY_POLICY',
      'Claude CLI가 요청한 비대화형 권한 모드로 시작되지 않았습니다.',
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

function webSearchResultError(event, block) {
  if (resultIsError(event, block)) return resultErrorDetails(event, block);
  const value = event?.tool_use_result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '구조화된 WebSearch 결과가 없습니다.';
  }
  if (typeof value.query !== 'string' || !value.query.trim()) {
    return 'WebSearch 결과에 실행된 query가 없습니다.';
  }
  if (!Array.isArray(value.results) || value.results.length === 0) {
    return 'WebSearch results가 비어 있습니다.';
  }
  if (value.searchCount !== undefined
    && (!Number.isSafeInteger(value.searchCount) || value.searchCount < 1)) {
    return `WebSearch searchCount가 올바르지 않습니다: ${String(value.searchCount)}`;
  }
  return '';
}

function isUnexpectedToolBlock(block) {
  const type = String(block?.type || '');
  return type !== 'tool_use' && /tool/i.test(type);
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
    if (event.type === 'system' && /^(?:task_|files_persisted|memory_)/.test(String(event.subtype))) {
      throw streamError('SECURITY_POLICY', '허용되지 않은 Claude 백그라운드 또는 저장 이벤트가 감지되었습니다.');
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
        if (!block || typeof block !== 'object') continue;
        if (isUnexpectedToolBlock(block)) {
          throw streamError(
            'SECURITY_POLICY',
            '허용되지 않은 Claude 서버 또는 확장 도구 블록이 감지되어 결과를 폐기했습니다.',
            `${String(block.type || '(형식 없음)')}: ${String(block.name || '(이름 없음)')}`,
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
        searches.set(id, { status: 'pending' });
      }
      continue;
    }
    if (event.type === 'user') {
      if (event.parent_tool_use_id) {
        throw streamError('SECURITY_POLICY', 'Claude 하위 에이전트 도구 결과가 감지되어 결과를 폐기했습니다.');
      }
      for (const block of eventContent(event)) {
        if (!block || typeof block !== 'object') continue;
        if (block.type !== 'tool_result' && /tool/i.test(String(block.type || ''))) {
          throw streamError(
            'SECURITY_POLICY',
            '허용되지 않은 Claude 서버 또는 확장 도구 결과가 감지되어 결과를 폐기했습니다.',
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
        const searchError = webSearchResultError(event, block);
        if (searchError) {
          search.status = 'failed';
          warnings.push(`WebSearch 실패: ${searchError}`);
        } else {
          search.status = 'success';
          collectUrls(block.content, groundingUrls, urlSet);
          collectUrls(event.tool_use_result, groundingUrls, urlSet);
        }
      }
      continue;
    }
    if (event.type === 'result') {
      finalResult = event;
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

  const success = [...searches.values()].filter((value) => value.status === 'success').length;
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

  const toolEvidence = {
    available: true,
    totalCalls: searches.size,
    totalSuccess: success,
    totalFail: fail,
    byName: {
      WebSearch: { count: searches.size, success, fail },
    },
  };
  return {
    response: finalResult.result,
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
    sessionId: typeof finalResult.session_id === 'string'
      ? finalResult.session_id
      : (typeof init.session_id === 'string' ? init.session_id : null),
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
  return { version: versionText, minimumVersion: MINIMUM_CLI_VERSION.join('.') };
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
