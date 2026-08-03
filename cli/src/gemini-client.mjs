import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_TASKKILL_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60000;
const MAX_PREFLIGHT_TIMEOUT_MS = 300000;
const MINIMUM_CLI_VERSION = [0, 40, 0];
const RESEARCH_TOOL = 'google_web_search';
const MCP_DENY_SENTINEL = '__newsletter_runner_no_mcp__';
const POLICY_FILE = fileURLToPath(new URL('../policies/research-only.toml', import.meta.url));
const RESEARCH_WORKSPACE_SETTINGS = `${JSON.stringify({
  tools: {
    core: [RESEARCH_TOOL],
    discoveryCommand: '',
    callCommand: '',
  },
  mcp: {
    allowed: [MCP_DENY_SENTINEL],
  },
  skills: {
    enabled: false,
  },
  hooksConfig: {
    enabled: false,
  },
  security: {
    disableYoloMode: true,
    disableAlwaysAllow: true,
  },
  experimental: {
    taskTracker: false,
    autoMemory: false,
  },
}, null, 2)}\n`;
const EXPECTED_POLICY = `# Gemini CLI non-interactive research policy.
# Keep this file in sync with cli/src/gemini-client.mjs.

[[rule]]
toolName = "google_web_search"
decision = "allow"
priority = 999
interactive = false

[[rule]]
toolName = "*"
decision = "deny"
priority = 998
interactive = false
denyMessage = "This runner permits Google web search only."
`;
const activeChildren = new Set();
const stoppingChildren = new WeakMap();

const ENVIRONMENT_ALLOWLIST = new Set([
  'ALL_PROXY',
  'APPDATA',
  'CODE_ASSIST_ENDPOINT',
  'CLOUDSDK_ACTIVE_CONFIG_NAME',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'CLOUDSDK_CONFIG',
  'CLOUDSDK_CORE_PROJECT',
  'COMSPEC',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_AUTH_SUPPRESS_CREDENTIALS_WARNINGS',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_UNIVERSE_DOMAIN',
  'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
  'GOOGLE_GEMINI_BASE_URL',
  'GOOGLE_GENAI_API_VERSION',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_VERTEX_BASE_URL',
  'GCE_METADATA_HOST',
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_SURFACE',
  'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
  'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  'GEMINI_MODEL',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOSTNAME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
]);

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function safeModel(value) {
  const model = String(value || '').trim();
  if (!model || !/^[a-zA-Z0-9._:/-]+$/.test(model)) {
    throw new GeminiCliError('CONFIG', 'GEMINI_CLI_MODEL 값에 허용되지 않은 문자가 있습니다.');
  }
  return model;
}

function configuredCliBin() {
  const bin = String(process.env.GEMINI_CLI_BIN || 'gemini').trim();
  if (!bin || /[\0\r\n]/.test(bin)) {
    throw new GeminiCliError('CONFIG', 'GEMINI_CLI_BIN 값이 비어 있거나 줄바꿈 문자를 포함합니다.');
  }
  if (process.platform === 'win32' && /["%!]/.test(bin)) {
    throw new GeminiCliError(
      'CONFIG',
      'Windows의 GEMINI_CLI_BIN 경로에는 ", %, ! 문자를 사용할 수 없습니다.',
    );
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

async function assertWindowsCliAvailable() {
  if (process.platform !== 'win32') return;
  const bin = configuredCliBin();
  if (path.isAbsolute(bin)) {
    if (await fileExists(bin)) return;
    throw new GeminiCliError('CLI_NOT_FOUND', `Gemini CLI 실행 파일을 찾을 수 없습니다: ${bin}`);
  }
  if (/[\\/]/.test(bin)) {
    throw new GeminiCliError(
      'CONFIG',
      'GEMINI_CLI_BIN에 폴더를 포함할 때는 절대경로를 사용해야 합니다.',
    );
  }

  const extensions = path.extname(bin)
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
      if (await fileExists(path.join(directory, `${bin}${extension}`))) return;
    }
  }
  throw new GeminiCliError(
    'CLI_NOT_FOUND',
    `Gemini CLI 실행 파일 '${bin}'을 PATH에서 찾을 수 없습니다.`,
  );
}

function quoteCmdToken(value, label) {
  const token = String(value);
  if (!token || /[\0\r\n"%!]/.test(token)) {
    throw new GeminiCliError('CONFIG', `${label} 값은 Windows 명령줄에서 안전하게 전달할 수 없습니다.`);
  }
  return `"${token}"`;
}

export class GeminiCliError extends Error {
  constructor(code, message, details = '') {
    super(message);
    this.name = 'GeminiCliError';
    this.code = code;
    this.details = details;
  }
}

function classifyError(message, exitCode) {
  const text = String(message || '');
  if (/not recognized|command not found|찾을 수 없/i.test(text)) return 'CLI_NOT_FOUND';
  if (
    /unknown (?:argument|option)|unknown arguments|unrecognized option|invalid values?.*argument/i.test(text)
    && /prompt|policy|extensions|output-format|allowed-mcp-server-names|approval-mode|skip-trust/i.test(text)
  ) return 'CLI_VERSION';
  if (/failed to (?:load|parse).*policy|invalid.*policy|policy.*(?:parse|syntax).*error|invalid toml/i.test(text)) {
    return 'SECURITY_POLICY';
  }
  if (/turn limit|maximum.*turn|exit code 53/i.test(text) || exitCode === 53) return 'TURN_LIMIT';
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(text)) return 'RATE_LIMIT';
  if (/timeout|timed out|시간 초과|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(text)) return 'TIMEOUT';
  if (/\b50[0234]\b|service unavailable|temporarily unavailable|internal server error|backend error/i.test(text)) {
    return 'SERVICE';
  }
  if (/oauth|login|log in|sign in|authentication|credentials|unauthorized|access token|\b401\b/i.test(text)) {
    return 'AUTH';
  }
  if (/GOOGLE_CLOUD_PROJECT|project id|project.*required|프로젝트/i.test(text)) return 'PROJECT';
  if (/trusted folder|untrusted|workspace trust/i.test(text)) return 'TRUST';
  if (/policy|not allowed|permission denied|forbidden|disabled|blocked|\b403\b/i.test(text)) return 'POLICY';
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
    text() {
      const buffer = Buffer.concat(chunks, bytes);
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        try {
          return new TextDecoder('euc-kr').decode(buffer);
        } catch {
          return buffer.toString('utf8');
        }
      }
    },
  };
}

function researchArguments() {
  const args = [
    '--prompt', 'Follow the complete task provided on standard input and return only its requested JSON object.',
    '--output-format', 'json',
    '--policy', POLICY_FILE,
    '--extensions', 'none',
    '--allowed-mcp-server-names', MCP_DENY_SENTINEL,
    '--approval-mode', 'default',
    '--skip-trust',
  ];
  const model = String(process.env.GEMINI_CLI_MODEL || '').trim();
  if (model) args.push('--model', safeModel(model));
  return args;
}

function launchSpec(args) {
  const bin = configuredCliBin();
  if (process.platform !== 'win32') return { command: bin, args };

  const commandLine = [
    quoteCmdToken(bin, 'GEMINI_CLI_BIN'),
    ...args.map((arg) => quoteCmdToken(arg, 'Gemini CLI 인자')),
  ].join(' ');
  return {
    command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
    // windowsVerbatimArguments와 함께 /C 명령 전체를 한 쌍의 따옴표로 감싼다.
    args: ['/d', '/q', '/s', '/c', `"${commandLine}"`],
  };
}

function enterpriseEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (ENVIRONMENT_ALLOWLIST.has(normalized)) {
      env[key] = value;
    }
  }
  // API 키는 allowlist에 없으므로 자식 프로세스에 존재 자체를 전달하지 않는다.
  env.GEMINI_CLI_TRUST_WORKSPACE = 'true';
  env.NO_COLOR = '1';
  return env;
}

async function verifyBundledPolicy() {
  let policy;
  try {
    policy = await fs.readFile(POLICY_FILE, 'utf8');
  } catch (error) {
    throw new GeminiCliError(
      'SECURITY_POLICY',
      'Google 웹 검색 전용 정책 파일을 읽지 못했습니다.',
      error.message,
    );
  }
  if (policy.replaceAll('\r\n', '\n') !== EXPECTED_POLICY) {
    throw new GeminiCliError(
      'SECURITY_POLICY',
      'Google 웹 검색 전용 정책 파일이 변경되었습니다. 원본 파일을 복원해 주세요.',
      POLICY_FILE,
    );
  }
}

function settingsFileFor(cwd) {
  if (!cwd) {
    throw new GeminiCliError('SECURITY_POLICY', '격리된 Gemini 작업 폴더가 지정되지 않았습니다.');
  }
  return path.join(path.resolve(String(cwd)), '.gemini', 'settings.json');
}

export async function prepareResearchWorkspace(cwd) {
  const settingsFile = settingsFileFor(cwd);
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, RESEARCH_WORKSPACE_SETTINGS, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return settingsFile;
}

async function verifyResearchWorkspace(cwd) {
  const settingsFile = settingsFileFor(cwd);
  let settings;
  try {
    settings = await fs.readFile(settingsFile, 'utf8');
  } catch (error) {
    throw new GeminiCliError(
      'SECURITY_POLICY',
      '격리된 Gemini 작업 폴더의 검색 전용 설정을 읽지 못했습니다.',
      error.message,
    );
  }
  if (settings.replaceAll('\r\n', '\n') !== RESEARCH_WORKSPACE_SETTINGS) {
    throw new GeminiCliError(
      'SECURITY_POLICY',
      '격리된 Gemini 작업 폴더의 검색 전용 설정이 변경되었습니다.',
      settingsFile,
    );
  }
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
      resolve({ code, details: `${capture.text().trim() || fallback}${suffix}`.trim() });
    };
    confirmationTimer = setTimeout(() => {
      done(null, 'taskkill 종료 명령이 5초 안에 끝나지 않아 중단했습니다.');
    }, 6500);
    stopTimer = setTimeout(() => {
      timedOut = true;
      try { killer.kill(); } catch {}
    }, 5000);
    killer.once('error', (error) => done(null, error.message));
    killer.once('close', (code, signal) => {
      if (timedOut) {
        done(null, 'taskkill 종료 명령이 5초 안에 끝나지 않아 중단했습니다.');
        return;
      }
      done(code, signal ? `taskkill이 ${signal} 신호로 종료됨` : '');
    });
  });
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ closed: true, treeConfirmed: true, details: '' });
  }
  const existing = stoppingChildren.get(child);
  if (existing) return existing;

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

export async function stopAllGeminiProcesses() {
  const statuses = await Promise.allSettled([...activeChildren].map((child) => stopProcessTree(child)));
  for (const status of statuses) {
    if (status.status === 'fulfilled' && (!status.value.closed || !status.value.treeConfirmed)) {
      console.warn(`Gemini 프로세스 트리 종료 경고: ${status.value.details || '완전한 종료를 확인하지 못했습니다.'}`);
    }
  }
}

export function isRetryableGeminiError(error) {
  return ['TIMEOUT', 'RATE_LIMIT', 'SERVICE'].includes(error?.code);
}

export function retryMax() {
  return positiveInt(process.env.GEMINI_CLI_RETRY_MAX, 2, 3);
}

export function timeoutMs() {
  return positiveInt(process.env.GEMINI_CLI_TIMEOUT_MS, 600000, 1800000);
}

export function preflightTimeoutMs() {
  return positiveInt(
    process.env.GEMINI_CLI_PREFLIGHT_TIMEOUT_MS,
    DEFAULT_PREFLIGHT_TIMEOUT_MS,
    MAX_PREFLIGHT_TIMEOUT_MS,
  );
}

export function totalTimeoutMs() {
  return positiveInt(process.env.GEMINI_RUN_TIMEOUT_MS, 2700000, 14400000);
}

function signalError(signal) {
  const reason = signal?.reason;
  return reason?.code === 'RUN_TIMEOUT'
    ? new GeminiCliError('RUN_TIMEOUT', reason.message || '전체 실행 제한 시간을 초과했습니다.', reason.details || '')
    : new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.');
}

async function executeCli(args, options = {}) {
  await assertWindowsCliAvailable();
  const timeout = positiveInt(options.timeoutMs, DEFAULT_PREFLIGHT_TIMEOUT_MS, 1800000);
  const spec = launchSpec(args);

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
        windowsVerbatimArguments: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : classifyError(error?.message);
      reject(new GeminiCliError(code, `Gemini CLI를 실행하지 못했습니다: ${error.message}`));
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
      const cleanup = await stopProcessTree(child);
      if (!cleanup.closed || !cleanup.treeConfirmed) {
        const cleanupDetail = cleanup.details || 'Gemini 프로세스 트리의 완전한 종료를 확인하지 못했습니다.';
        console.warn(`프로세스 정리 추가 경고(원래 오류와 별개): ${cleanupDetail}`);
      }
      finish(() => reject(error));
    };

    const onAbort = () => {
      void forceStop(signalError(options.signal));
    };

    timer = setTimeout(() => {
      const timeoutMessage = options.timeoutMessage
        || `Gemini 응답이 ${Math.max(1, Math.round(timeout / 60000))}분 안에 끝나지 않았습니다.`;
      void forceStop(new GeminiCliError(options.timeoutCode || 'TIMEOUT', timeoutMessage));
    }, timeout);

    if (options.heartbeat) {
      heartbeat = setInterval(() => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`  ... Gemini 조사 중 (${seconds}초 경과)`);
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
        void forceStop(new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 출력이 허용 크기를 초과했습니다.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (!stderrCapture.append(chunk)) {
        void forceStop(new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 오류 출력이 허용 크기를 초과했습니다.'));
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (forcedError) return;
      const code = error?.code === 'ENOENT' ? 'CLI_NOT_FOUND' : classifyError(error.message);
      finish(() => reject(new GeminiCliError(code, `Gemini CLI 실행 오류: ${error.message}`)));
    });
    child.on('close', (exitCode, signalCode) => {
      if (forcedError) return;
      finish(() => resolve({
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
        exitCode,
        signalCode,
      }));
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, 'utf8');
  });
}

function exitFailure(result, contextMessage) {
  const stdout = result.stdout.trim().slice(0, 3000);
  const stderr = result.stderr.trim().slice(0, 3000);
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const detail = [stderr, stdout].filter(Boolean).join('\n').slice(0, 3000);
  const code = classifyError(combined, result.exitCode);
  return new GeminiCliError(code, `${contextMessage}(${code})`, detail);
}

export function extractToolEvidence(stats) {
  const tools = stats && typeof stats === 'object' ? stats.tools : null;
  const rawByName = tools && typeof tools === 'object' && tools.byName && typeof tools.byName === 'object'
    ? tools.byName
    : null;
  const byName = {};
  if (rawByName) {
    for (const [name, raw] of Object.entries(rawByName)) {
      if (!raw || typeof raw !== 'object') continue;
      const metric = (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : 0;
      };
      Object.defineProperty(byName, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: {
          count: metric(raw.count),
          success: metric(raw.success),
          fail: metric(raw.fail),
        },
      });
    }
  }
  return {
    available: Boolean(rawByName),
    totalCalls: Number.isFinite(tools?.totalCalls) ? tools.totalCalls : 0,
    totalSuccess: Number.isFinite(tools?.totalSuccess) ? tools.totalSuccess : 0,
    totalFail: Number.isFinite(tools?.totalFail) ? tools.totalFail : 0,
    byName,
  };
}

function normalizeWarnings(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 응답의 warnings 형식이 올바르지 않습니다.');
  }
  return value.map((warning) => (
    typeof warning === 'string' ? warning : JSON.stringify(warning)
  )).filter(Boolean);
}

function assertObservedToolBoundary(evidence) {
  const forbidden = Object.entries(evidence.byName)
    .filter(([name, stats]) => (
      name !== RESEARCH_TOOL && (stats.count > 0 || stats.success > 0 || stats.fail > 0)
    ))
    .map(([name]) => name);
  if (forbidden.length > 0) {
    throw new GeminiCliError(
      'SECURITY_POLICY',
      '허용되지 않은 Gemini CLI 도구 호출이 감지되어 결과를 폐기했습니다.',
      `감지된 도구: ${forbidden.join(', ')}`,
    );
  }
}

export function parseCliVersion(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:gemini(?:\s+cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?\s*$/i,
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

export async function preflightGeminiCli(options = {}) {
  await verifyBundledPolicy();
  await verifyResearchWorkspace(options.cwd);
  const timeout = positiveInt(
    options.timeoutMs,
    preflightTimeoutMs(),
    MAX_PREFLIGHT_TIMEOUT_MS,
  );
  const result = await executeCli(['--version'], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: timeout,
    timeoutCode: 'CLI_STARTUP_TIMEOUT',
    timeoutMessage: `Gemini CLI 시작 확인이 ${Math.max(1, Math.round(timeout / 1000))}초 안에 끝나지 않았습니다.`,
  });
  if (result.exitCode !== 0) throw exitFailure(result, 'Gemini CLI 사전 점검 오류');

  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  const version = parseCliVersion(versionOutput);
  if (!version) {
    throw new GeminiCliError(
      'CLI_VERSION',
      '설치된 Gemini CLI의 버전을 확인하지 못했습니다.',
      `버전 출력: ${versionOutput.slice(0, 1000) || '(출력 없음)'}`,
    );
  }
  const versionText = `${version.parts.join('.')}${version.prerelease}`;
  if (!isMinimumCliVersion(version)) {
    throw new GeminiCliError(
      'CLI_VERSION',
      '설치된 Gemini CLI가 안전한 자동 조사에 필요한 최소 버전보다 낮습니다.',
      `감지된 버전: ${versionText}\n필요한 최소 버전: ${MINIMUM_CLI_VERSION.join('.')}`,
    );
  }
  return { policyPath: POLICY_FILE, version: versionText };
}

export async function callGeminiCli(prompt, options = {}) {
  await verifyBundledPolicy();
  await verifyResearchWorkspace(options.cwd);
  const timeout = positiveInt(options.timeoutMs, timeoutMs(), 1800000);
  const result = await executeCli(researchArguments(), {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: timeout,
    input: prompt,
    heartbeat: true,
  });
  if (result.exitCode !== 0) throw exitFailure(result, 'Gemini CLI 오류');

  let envelope;
  try {
    envelope = JSON.parse(result.stdout.trim());
  } catch {
    throw new GeminiCliError(
      'BAD_OUTPUT',
      'Gemini CLI의 JSON 응답을 읽지 못했습니다.',
      result.stdout.trim().slice(0, 1000),
    );
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new GeminiCliError('BAD_OUTPUT', 'Gemini CLI가 JSON 객체를 반환하지 않았습니다.');
  }
  if (envelope.error) {
    const detail = envelope.error.message || JSON.stringify(envelope.error);
    throw new GeminiCliError(classifyError(detail), 'Gemini CLI가 오류를 반환했습니다.', detail);
  }
  if (typeof envelope.response !== 'string') {
    throw new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 응답에 response 문자열이 없습니다.');
  }

  const stats = envelope.stats && typeof envelope.stats === 'object' ? envelope.stats : null;
  const warnings = normalizeWarnings(envelope.warnings);
  const toolEvidence = extractToolEvidence(stats);
  assertObservedToolBoundary(toolEvidence);
  return {
    response: envelope.response,
    stats,
    warnings,
    toolEvidence,
    sessionId: typeof envelope.session_id === 'string' ? envelope.session_id : null,
  };
}
