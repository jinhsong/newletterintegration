import fs from 'node:fs/promises';
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
  semverAtLeast,
} from './cli-launch.mjs';
import {
  classifySiteFilteredQuery,
  normalizedProviderEnvelope,
} from './provider-evidence.mjs';

const PROVIDER_LABEL = 'Gemini CLI';
const RESEARCH_TOOL = 'google_web_search';
const MINIMUM_CLI_VERSION = [0, 53, 0];
const MAX_STREAM_EVENTS = 20000;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const FIXED_PROMPT = '위 표준 입력의 전체 지시를 수행하고 지정된 JSON 객체만 출력하세요.';
const preparedWorkspaces = new Set();

const RESEARCH_WORKSPACE_SETTINGS = `${JSON.stringify({
  tools: { core: [RESEARCH_TOOL], allowed: [RESEARCH_TOOL] },
  mcp: { allowed: [] },
  hooksConfig: { enabled: false },
  skills: { enabled: false },
  experimental: { enableAgents: false },
  context: {
    fileName: ['.trade-monitor-no-context'],
    includeDirectoryTree: false,
  },
  advanced: { ignoreLocalEnv: true },
}, null, 2)}\n`;

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
  // 이 선택지는 저장된 회사 Google 로그인만 사용한다. 우연히 설정된 개인 API key로
  // 과금·정책 경계가 바뀌지 않도록 key 방식만 제거하고 회사 proxy/CA/project 설정은 유지한다.
  deleteEnvironmentKey(environment, 'GEMINI_API_KEY');
  deleteEnvironmentKey(environment, 'GOOGLE_API_KEY');
  environment.NO_COLOR = '1';
  return environment;
}

function classifyError(message, exitCode) {
  const value = String(message || '');
  if (exitCode === 41 || /oauth|login|log in|sign in|authentication|credentials|unauthorized|not authenticated|\b401\b/i.test(value)) {
    return 'AUTH';
  }
  if (exitCode === 53 || /maximum session turns|turn limit|max(?:imum)? turns?/i.test(value)) return 'TURN_LIMIT';
  if (exitCode === 44 || /sandbox/i.test(value) && /failed|error|unavailable|not found/i.test(value)) return 'POLICY';
  if (exitCode === 52) return 'CONFIG';
  if (/not recognized|command not found|no such file|찾을 수 없/i.test(value)) return 'CLI_NOT_FOUND';
  if (/unknown (?:argument|option)|unknown arguments|unrecognized option|invalid values?.*argument/i.test(value)
    && /prompt|output-format|approval-mode|extensions|skip-trust|model/i.test(value)) return 'CLI_VERSION';
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(value)) return 'RATE_LIMIT';
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN/i.test(value)) return 'TIMEOUT';
  if (/\b50[02349]\b|service unavailable|temporarily unavailable|internal server error|overloaded|backend error/i.test(value)) return 'SERVICE';
  if (/web search|google_web_search/i.test(value)
    && /not available|unsupported|disabled|blocked|사용할 수 없|지원하지 않/i.test(value)) return 'WEB_SEARCH_UNAVAILABLE';
  if (/permission denied|forbidden|policy|not allowed|blocked|\b403\b/i.test(value)) return 'POLICY';
  if (exitCode === 42) return 'CONFIG';
  return 'CLI_EXIT';
}

export function geminiResearchArguments() {
  const args = [
    '--prompt', FIXED_PROMPT,
    '--output-format', 'stream-json',
    '--approval-mode', 'default',
    '--extensions', 'none',
    '--skip-trust',
  ];
  const model = String(process.env.GEMINI_CLI_MODEL || '').trim();
  if (model) args.push('--model', safeCliModel(model, 'GEMINI_CLI_MODEL'));
  return args;
}

async function execute(args, options = {}) {
  const spec = await buildCliLaunchSpec({
    args,
    defaultBin: 'gemini',
    envName: 'GEMINI_CLI_BIN',
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
  if (!cwd) throw new ClaudeCliError('SECURITY_POLICY', '격리된 Gemini 작업 폴더가 지정되지 않았습니다.');
  return path.resolve(String(cwd));
}

async function workspaceEntries(workspace) {
  const entries = [];
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const childPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new ClaudeCliError('SECURITY_POLICY', 'Gemini 임시 작업 폴더에 심볼릭 링크가 생겼습니다.', childRelative);
      }
      entries.push(childRelative.split(path.sep).join('/'));
      if (entry.isDirectory()) await walk(childPath, childRelative);
    }
  }
  await walk(workspace);
  return entries.sort();
}

export async function prepareGeminiResearchWorkspace(cwd) {
  const workspace = normalizedWorkspace(cwd);
  const initial = await fs.readdir(workspace);
  if (initial.length > 0) {
    throw new ClaudeCliError('SECURITY_POLICY', 'Gemini 임시 작업 폴더가 처음부터 비어 있지 않습니다.');
  }
  const settingsDirectory = path.join(workspace, '.gemini');
  await fs.mkdir(settingsDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(settingsDirectory, 'settings.json'), RESEARCH_WORKSPACE_SETTINGS, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  preparedWorkspaces.add(workspace);
  return workspace;
}

async function verifyResearchWorkspace(cwd) {
  const workspace = normalizedWorkspace(cwd);
  if (!preparedWorkspaces.has(workspace)) {
    throw new ClaudeCliError('SECURITY_POLICY', '현재 실행기가 준비하지 않은 Gemini 작업 폴더입니다.');
  }
  const expected = ['.gemini', '.gemini/settings.json'];
  const actual = await workspaceEntries(workspace);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      'Gemini 임시 작업 폴더에 예상하지 않은 파일이 생겼습니다.',
      actual.join(', '),
    );
  }
  const settings = await fs.readFile(path.join(workspace, '.gemini', 'settings.json'), 'utf8');
  if (settings.replaceAll('\r\n', '\n') !== RESEARCH_WORKSPACE_SETTINGS) {
    throw new ClaudeCliError('SECURITY_POLICY', 'Gemini 검색 전용 작업 설정이 변경되었습니다.');
  }
  return workspace;
}

export function parseGeminiStream(output, options = {}) {
  const lines = String(output || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI가 완전한 stream-json을 반환하지 않았습니다.');
  if (lines.length > MAX_STREAM_EVENTS) throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI 이벤트 수가 허용 범위를 초과했습니다.');

  let init = null;
  let result = null;
  let response = '';
  let assistantMode = null;
  const searches = new Map();
  const warnings = [];
  let fatalEvent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
      throw new ClaudeCliError('BAD_OUTPUT', `Gemini CLI JSONL ${index + 1}번째 줄이 너무 큽니다.`);
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new ClaudeCliError('BAD_OUTPUT', `Gemini CLI JSONL ${index + 1}번째 줄을 읽지 못했습니다.`, error.message);
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new ClaudeCliError('BAD_OUTPUT', `Gemini CLI JSONL ${index + 1}번째 이벤트 형식이 올바르지 않습니다.`);
    }
    if (result) throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI 최종 result 뒤에 추가 이벤트가 있습니다.');

    if (event.type === 'init') {
      if (init || index !== 0 || typeof event.session_id !== 'string' || typeof event.model !== 'string') {
        throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI init 이벤트가 올바르지 않습니다.');
      }
      init = event;
      continue;
    }
    if (!init) throw new ClaudeCliError('SECURITY_POLICY', 'Gemini CLI init 검증 전에 다른 이벤트가 실행되었습니다.');

    if (event.type === 'message') {
      if (!['user', 'assistant'].includes(event.role) || typeof event.content !== 'string') {
        throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI message 이벤트 형식이 올바르지 않습니다.');
      }
      if (event.role === 'assistant') {
        const currentMode = event.delta === true ? 'delta' : 'complete';
        if (assistantMode && assistantMode !== currentMode) {
          throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI assistant 메시지의 delta 형식이 실행 중 바뀌었습니다.');
        }
        assistantMode = currentMode;
        response = currentMode === 'delta' ? response + event.content : event.content;
      }
      continue;
    }
    if (event.type === 'tool_use') {
      if (event.tool_name !== RESEARCH_TOOL) {
        throw new ClaudeCliError(
          'SECURITY_POLICY',
          '허용되지 않은 Gemini CLI 도구 호출이 감지되었습니다.',
          String(event.tool_name || '(이름 없음)'),
        );
      }
      const toolUseId = typeof event.tool_id === 'string' ? event.tool_id.trim() : '';
      const parameters = event.parameters;
      if (!toolUseId || searches.has(toolUseId)
        || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)
        || Object.keys(parameters).some((key) => key !== 'query')
        || typeof parameters.query !== 'string') {
        throw new ClaudeCliError('BAD_OUTPUT', 'Gemini google_web_search 요청 형식이 올바르지 않습니다.');
      }
      searches.set(toolUseId, {
        toolUseId,
        status: 'pending',
        ...classifySiteFilteredQuery(parameters.query, options.officialDomainAllowlist || []),
      });
      continue;
    }
    if (event.type === 'tool_result') {
      const toolUseId = typeof event.tool_id === 'string' ? event.tool_id.trim() : '';
      const search = searches.get(toolUseId);
      if (!search || search.status !== 'pending') {
        throw new ClaudeCliError('BAD_OUTPUT', '대응하는 검색 요청이 없는 Gemini tool_result가 있습니다.');
      }
      if (event.status === 'success' && !event.error) {
        const display = typeof event.output === 'string'
          ? event.output
          : (typeof event.output?.returnDisplay === 'string'
            ? event.output.returnDisplay
            : JSON.stringify(event.output || ''));
        if (/^\s*(?:no information found\.?|no results? found\.?)\s*$/i.test(display)) {
          search.status = 'failed';
          warnings.push(`WebSearch 결과 없음: ${search.query}`);
        } else {
          search.status = 'success';
        }
      } else if (event.status === 'error') {
        search.status = 'failed';
        warnings.push(`WebSearch 실패: ${event.error?.message || event.output || '상세 없음'}`);
      } else {
        throw new ClaudeCliError('BAD_OUTPUT', 'Gemini tool_result의 status가 올바르지 않습니다.');
      }
      continue;
    }
    if (event.type === 'error') {
      const message = typeof event.message === 'string' ? event.message.trim() : '';
      if (!message || !['warning', 'error'].includes(event.severity)) {
        throw new ClaudeCliError('BAD_OUTPUT', 'Gemini error 이벤트 형식이 올바르지 않습니다.');
      }
      if (event.severity === 'error') fatalEvent = message;
      else warnings.push(message);
      continue;
    }
    if (event.type === 'result') {
      result = event;
      continue;
    }
    throw new ClaudeCliError(
      'SECURITY_POLICY',
      '알려지지 않은 Gemini CLI 이벤트가 감지되었습니다.',
      event.type,
    );
  }

  if (!result || result.status !== 'success' || fatalEvent || result.error) {
    const detail = fatalEvent || result?.error?.message || JSON.stringify(result || {});
    throw new ClaudeCliError(classifyError(detail), 'Gemini CLI가 조사를 완료하지 못했습니다.', detail);
  }
  const pending = [...searches.values()].filter((search) => search.status === 'pending');
  if (pending.length > 0) throw new ClaudeCliError('BAD_OUTPUT', '결과가 확인되지 않은 Gemini 검색 호출이 있습니다.');
  if (!response.trim()) throw new ClaudeCliError('BAD_OUTPUT', 'Gemini CLI 최종 assistant 응답이 비어 있습니다.');

  return {
    ...normalizedProviderEnvelope({
      providerKey: 'gemini',
      providerLabel: PROVIDER_LABEL,
      response,
      searches: [...searches.values()],
      stats: result.stats || null,
      warnings,
    }),
    sessionId: init.session_id,
    model: init.model,
  };
}

function structuredFailureDiagnostic(output) {
  const messages = [];
  for (const line of String(output || '').split(/\r?\n/).filter((entry) => entry.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    if (event.type === 'error' && event.severity === 'error') {
      const detail = event.message || event.error?.message;
      if (typeof detail === 'string' && detail.trim()) messages.push(detail.trim());
    } else if (event.type === 'result' && event.status !== 'success') {
      const detail = event.error?.message || event.message;
      if (typeof detail === 'string' && detail.trim()) messages.push(detail.trim());
    }
  }
  return messages.join('\n').slice(0, 3000);
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

export function geminiRetryMax() {
  return positiveInt(process.env.GEMINI_CLI_RETRY_MAX, 2, 3);
}

export function geminiTimeoutMs() {
  return positiveInt(process.env.GEMINI_CLI_TIMEOUT_MS, 600000, 1800000);
}

export function geminiPreflightTimeoutMs() {
  return positiveInt(process.env.GEMINI_CLI_PREFLIGHT_TIMEOUT_MS, 60000, 300000);
}

export function geminiTotalTimeoutMs() {
  return positiveInt(process.env.GEMINI_RUN_TIMEOUT_MS, 7200000, 14400000);
}

export function isRetryableGeminiError(error) {
  return ['TIMEOUT', 'RATE_LIMIT', 'SERVICE'].includes(error?.code);
}

export async function preflightGeminiCli(options = {}) {
  const cwd = await verifyResearchWorkspace(options.cwd);
  const result = await execute(['--version'], {
    cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs || geminiPreflightTimeoutMs(),
    timeoutCode: 'CLI_STARTUP_TIMEOUT',
    timeoutMessage: 'Gemini CLI 버전 확인이 제한 시간 안에 끝나지 않았습니다.',
  });
  await verifyResearchWorkspace(cwd);
  if (result.exitCode !== 0 || result.signalCode) throw exitFailure(result, 'Gemini CLI 사전 점검 오류');
  const version = parseCliSemver(`${result.stdout}\n${result.stderr}`, '(?:gemini(?:\\s+cli)?)');
  if (!version || !semverAtLeast(version, MINIMUM_CLI_VERSION)) {
    throw new ClaudeCliError(
      'CLI_VERSION',
      'Gemini CLI 0.53.0 이상이 필요합니다.',
      `버전 출력: ${`${result.stdout}\n${result.stderr}`.trim().slice(0, 1000) || '(없음)'}`,
    );
  }
  return {
    version: `${version.parts.join('.')}${version.prerelease}`,
    executablePath: result.executablePath,
    diagnostics: {
      authMethod: '회사 Gemini 로그인(첫 조사에서 확인)',
      warnings: ['설치 버전만 확인했습니다. 회사 로그인과 Google Search 권한은 첫 조사 호출에서 확인합니다.'],
    },
  };
}

export async function callGeminiCli(prompt, options = {}) {
  const cwd = await verifyResearchWorkspace(options.cwd);
  let result;
  try {
    result = await execute(geminiResearchArguments(), {
      cwd,
      signal: options.signal,
      timeoutMs: options.timeoutMs || geminiTimeoutMs(),
      input: prompt,
      heartbeat: true,
    });
  } finally {
    await verifyResearchWorkspace(cwd);
  }
  if (result.exitCode !== 0 || result.signalCode) throw exitFailure(result, 'Gemini CLI 오류');
  return parseGeminiStream(result.stdout, options);
}
