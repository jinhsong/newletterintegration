import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  ClaudeCliError,
  callClaudeCli,
  createProcessCleanupError,
  parseCliVersion,
  prepareResearchWorkspace,
  preflightClaudeCli,
  preflightTimeoutMs,
  resolveForcedStopError,
  retryMax,
  stopAllClaudeProcesses,
  totalTimeoutMs,
} from '../src/claude-client.mjs';

const DOMAIN_JSON = JSON.stringify({
  domain: 'customs',
  insight: '',
  categories: { '북미': [] },
});

const FIXED_PROMPT = 'Follow the complete task provided on standard input. Use WebSearch for evidence and return only the requested JSON object.';

const REQUIRED_RESEARCH_ARGS = [
  '--safe-mode',
  '--no-chrome',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--disallowedTools', 'mcp__*',
  '--tools', 'WebSearch',
  '--allowedTools', 'WebSearch',
  '--permission-mode', 'dontAsk',
  '--no-session-persistence',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-hook-events',
  '--max-turns', '20',
  '-p', FIXED_PROMPT,
];

function initEvent(overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'session-1',
    claude_code_version: '2.1.214',
    tools: ['WebSearch'],
    mcp_servers: [],
    mcp_server_errors: [],
    permissionMode: 'dontAsk',
    plugins: [],
    plugin_errors: [],
    skills: [],
    slash_commands: [],
    agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
    hooks: [],
    ...overrides,
  };
}

function assistantToolUse(id, name = 'WebSearch', input = { query: '수출통제 동향' }) {
  return {
    type: 'assistant',
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  };
}

function userToolResult(id, options = {}) {
  const block = {
    type: 'tool_result',
    tool_use_id: id,
    content: options.content ?? '공식 결과 https://agency.gov/rule',
  };
  if (options.isError !== undefined) block.is_error = options.isError;
  const event = {
    type: 'user',
    session_id: 'session-1',
    parent_tool_use_id: null,
    message: { role: 'user', content: [block] },
  };
  if (options.structuredResult !== null) {
    event.tool_use_result = options.structuredResult ?? {
      query: '수출통제 동향',
      results: [{
        tool_use_id: id,
        content: [{ title: '공식 결과', url: 'https://agency.gov/rule' }],
      }],
      durationSeconds: 0.1,
      searchCount: 1,
    };
  }
  return event;
}

function successResult(result = DOMAIN_JSON, overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: 'session-1',
    duration_ms: 20,
    duration_api_ms: 10,
    num_turns: 2,
    total_cost_usd: 0,
    permission_denials: [],
    ...overrides,
  };
}

function successfulSearchEvents(overrides = {}) {
  const id = overrides.id || 'toolu-search-1';
  return [
    initEvent(overrides.init),
    assistantToolUse(id, overrides.toolName || 'WebSearch'),
    userToolResult(id, {
      content: overrides.toolContent,
      isError: overrides.toolError,
      structuredResult: overrides.toolStructuredResult,
    }),
    successResult(overrides.result || DOMAIN_JSON, overrides.resultOverrides),
  ];
}

function fakeDriverSource(behavior) {
  const encoded = Buffer.from(JSON.stringify(behavior), 'utf8').toString('base64');
  return `
import fs from 'node:fs/promises';

const behavior = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8'));
const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
const selectedEnv = Object.fromEntries(
  (behavior.captureEnv || []).map((name) => [name, process.env[name] ?? null]),
);
await fs.writeFile(new URL('./invocation.json', import.meta.url), JSON.stringify({
  args,
  stdin,
  cwd: process.cwd(),
  env: selectedEnv,
}), 'utf8');

const versionCall = args.length === 1 && args[0] === '--version';
const selected = versionCall ? (behavior.version || {}) : (behavior.research || behavior);
if (selected.delayMs) await new Promise((resolve) => setTimeout(resolve, selected.delayMs));
if (selected.stdoutRaw !== undefined) process.stdout.write(selected.stdoutRaw);
for (const event of selected.events || []) process.stdout.write(JSON.stringify(event) + '\\n');
if (selected.versionText !== undefined) process.stdout.write(String(selected.versionText) + '\\n');
if (selected.stderr) process.stderr.write(String(selected.stderr));
process.exitCode = selected.exitCode ?? 0;
`;
}

async function withFakeClaude(behavior, worker, options = {}) {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-claude-cli-'));
  const binDirectory = options.binSubdirectory
    ? path.join(rootDirectory, options.binSubdirectory)
    : path.join(rootDirectory, 'bin');
  const directory = path.join(rootDirectory, 'workspace');
  await fs.mkdir(binDirectory, { recursive: true });
  await fs.mkdir(directory);
  const command = path.join(binDirectory, 'fake-claude.cmd');
  const driver = path.join(binDirectory, 'fake-claude.mjs');
  const runtime = path.join(binDirectory, 'node.exe');
  const invocation = path.join(binDirectory, 'invocation.json');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'Path';
  const originalPath = process.env[pathKey];
  const originalBin = process.env.CLAUDE_CLI_BIN;
  const originalModel = process.env.CLAUDE_CLI_MODEL;
  try {
    await fs.writeFile(driver, fakeDriverSource(behavior), 'utf8');
    await fs.link(process.execPath, runtime);
    await fs.writeFile(
      command,
      '@echo off\r\n"%~dp0node.exe" "%~dp0fake-claude.mjs" %*\r\n',
      'utf8',
    );
    await prepareResearchWorkspace(directory);
    process.env[pathKey] = `${binDirectory};${originalPath || ''}`;
    process.env.CLAUDE_CLI_BIN = options.absoluteBin ? command : 'fake-claude';
    if (options.model) process.env.CLAUDE_CLI_MODEL = options.model;
    else delete process.env.CLAUDE_CLI_MODEL;
    return await worker({ directory, rootDirectory, command, invocation });
  } finally {
    await stopAllClaudeProcesses();
    process.env[pathKey] = originalPath;
    if (originalBin === undefined) delete process.env.CLAUDE_CLI_BIN;
    else process.env.CLAUDE_CLI_BIN = originalBin;
    if (originalModel === undefined) delete process.env.CLAUDE_CLI_MODEL;
    else process.env.CLAUDE_CLI_MODEL = originalModel;
    await fs.rm(rootDirectory, { recursive: true, force: true });
  }
}

async function readInvocation(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

test('재시도 환경변수는 숫자 전체가 올바를 때만 허용한다', () => {
  const original = process.env.CLAUDE_CLI_RETRY_MAX;
  try {
    process.env.CLAUDE_CLI_RETRY_MAX = '3abc';
    assert.equal(retryMax(), 2);
    process.env.CLAUDE_CLI_RETRY_MAX = '3';
    assert.equal(retryMax(), 3);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CLI_RETRY_MAX;
    else process.env.CLAUDE_CLI_RETRY_MAX = original;
  }
});

test('전체 실행 제한은 기본 45분이며 안전한 정수 환경변수만 반영한다', () => {
  const original = process.env.CLAUDE_RUN_TIMEOUT_MS;
  try {
    delete process.env.CLAUDE_RUN_TIMEOUT_MS;
    assert.equal(totalTimeoutMs(), 2700000);
    process.env.CLAUDE_RUN_TIMEOUT_MS = '3600000';
    assert.equal(totalTimeoutMs(), 3600000);
    process.env.CLAUDE_RUN_TIMEOUT_MS = '10minutes';
    assert.equal(totalTimeoutMs(), 2700000);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_RUN_TIMEOUT_MS;
    else process.env.CLAUDE_RUN_TIMEOUT_MS = original;
  }
});

test('CLI 시작 확인 제한은 기본 60초이며 최대 5분까지만 허용한다', () => {
  const original = process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS;
  try {
    delete process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS;
    assert.equal(preflightTimeoutMs(), 60000);
    process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS = '120000';
    assert.equal(preflightTimeoutMs(), 120000);
    process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS = '300000';
    assert.equal(preflightTimeoutMs(), 300000);
    process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS = '300001';
    assert.equal(preflightTimeoutMs(), 60000);
    for (const invalid of ['0', '-1', '1.5', 'minute']) {
      process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS = invalid;
      assert.equal(preflightTimeoutMs(), 60000);
    }
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS;
    else process.env.CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS = original;
  }
});

test('Claude Code 버전 파서는 사내 배너를 무시하고 공식 버전 행만 읽는다', () => {
  assert.deepEqual(parseCliVersion('Security Agent 8.2.1\r\n2.1.156 (Claude Code)\r\n'), {
    parts: [2, 1, 156],
    prerelease: '',
  });
  assert.deepEqual(parseCliVersion('2.1.80'), {
    parts: [2, 1, 80],
    prerelease: '',
  });
  assert.equal(parseCliVersion('Security Agent 8.2.1'), null);
  assert.equal(parseCliVersion('Claude Desktop 1.2.3'), null);
});

test('프로세스 정리 실패 오류는 원래 오류와 정리 상태 및 PID를 보존한다', () => {
  const original = new ClaudeCliError('TIMEOUT', 'Claude 응답 제한 시간 초과', '원래 상세');
  const error = createProcessCleanupError(original, {
    closed: false,
    treeConfirmed: false,
    details: 'taskkill 종료 명령 시간 초과',
  }, 4321);

  assert.equal(error.code, 'PROCESS_CLEANUP');
  assert.match(error.details, /원래 오류 \(TIMEOUT\): Claude 응답 제한 시간 초과/);
  assert.match(error.details, /원래 오류 상세: 원래 상세/);
  assert.match(error.details, /closed=false, treeConfirmed=false/);
  assert.match(error.details, /taskkill 종료 명령 시간 초과/);
  assert.match(error.details, /PID: 4321/);
  assert.equal(resolveForcedStopError(original, {
    closed: true,
    treeConfirmed: true,
  }, 4321), original);
  assert.equal(resolveForcedStopError(original, {
    closed: true,
    treeConfirmed: false,
    details: '트리 확인 실패',
  }, 4321).code, 'PROCESS_CLEANUP');
});

test('Windows stream-json 성공 응답에서 검색 증거와 근거 URL을 보존한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({ events: successfulSearchEvents() }, async ({ directory }) => {
    const result = await callClaudeCli('시험 프롬프트', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, DOMAIN_JSON);
    assert.equal(result.sessionId, 'session-1');
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.toolEvidence, {
      available: true,
      totalCalls: 1,
      totalSuccess: 1,
      totalFail: 0,
      byName: { WebSearch: { count: 1, success: 1, fail: 0 } },
    });
    assert.deepEqual(result.groundingUrls, ['https://agency.gov/rule']);
  });
});

test('Windows Claude 실행은 정확한 검색 전용 인자를 사용하고 프롬프트를 stdin으로만 보낸다', {
  skip: process.platform !== 'win32',
}, async () => {
  const prompt = '첫째 줄\n한글 & 특수문자 <시험>';
  await withFakeClaude({ events: successfulSearchEvents() }, async ({ directory, invocation }) => {
    await callClaudeCli(prompt, { cwd: directory, timeoutMs: 5000 });
    const observed = await readInvocation(invocation);
    assert.deepEqual(observed.args, REQUIRED_RESEARCH_ARGS);
    assert.equal(observed.stdin, prompt);
    assert.equal(path.resolve(observed.cwd), path.resolve(directory));
    assert.equal(observed.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(observed.args.includes('--add-dir'), false);
    assert.equal(observed.args.includes('--chrome'), false);
  });
});

test('WebSearch 병렬 호출은 tool_use_id로 결과를 짝지어 계산한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const events = [
    initEvent(),
    assistantToolUse('toolu-1'),
    assistantToolUse('toolu-2', 'WebSearch', { query: '관세 동향' }),
    userToolResult('toolu-2', {
      content: 'https://b.gov/rule',
      structuredResult: {
        query: '관세 동향',
        results: [{
          tool_use_id: 'srvtoolu-2',
          content: [{ title: 'B 공식 결과', url: 'https://b.gov/rule' }],
        }],
        durationSeconds: 0.1,
        searchCount: 1,
      },
    }),
    userToolResult('toolu-1', {
      content: 'https://a.gov/rule',
      isError: false,
      structuredResult: {
        query: '수출통제 동향',
        results: [{
          tool_use_id: 'srvtoolu-1',
          content: [{ title: 'A 공식 결과', url: 'https://a.gov/rule' }],
        }],
        durationSeconds: 0.1,
        searchCount: 1,
      },
    }),
    successResult(),
  ];
  await withFakeClaude({ events }, async ({ directory }) => {
    const result = await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.deepEqual(result.toolEvidence.byName.WebSearch, { count: 2, success: 2, fail: 0 });
    assert.deepEqual(result.groundingUrls.sort(), [
      'https://a.gov/rule',
      'https://b.gov/rule',
    ]);
  });
});

test('WebSearch 실패와 완료되지 않은 호출은 각각 명시적인 오류로 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    events: successfulSearchEvents({ toolError: true }),
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'SEARCH_FAILED',
    );
  });

  await withFakeClaude({
    events: successfulSearchEvents({
      toolStructuredResult: {
        query: '수출통제 동향',
        results: ['검색 실행 증거 없음'],
        durationSeconds: 0.1,
        searchCount: 0,
      },
    }),
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'SEARCH_FAILED' && /searchCount/.test(error.details),
    );
  });

  await withFakeClaude({
    events: [initEvent(), assistantToolUse('toolu-missing'), successResult()],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT',
    );
  });
});

test('일반 WebSearch와 섞인 server_tool_use 또는 서버 도구 결과도 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const serverToolUse = {
    type: 'server_tool_use',
    id: 'srvtoolu-1',
    name: 'web_fetch',
    input: { url: 'https://example.com' },
  };
  const events = successfulSearchEvents();
  events[1].message.content.push(serverToolUse);
  await withFakeClaude({ events }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'SECURITY_POLICY'
        && /server_tool_use/.test(error.details)
        && /web_fetch/.test(error.details),
    );
  });
});

for (const forbiddenTool of ['Read', 'Write', 'Bash', 'PowerShell', 'WebFetch', 'Agent', 'mcp__corp__search']) {
  test(`허용되지 않은 ${forbiddenTool} 호출은 결과를 폐기한다`, {
    skip: process.platform !== 'win32',
  }, async () => {
    const events = successfulSearchEvents({ toolName: forbiddenTool });
    await withFakeClaude({ events }, async ({ directory }) => {
      await assert.rejects(
        () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'SECURITY_POLICY' && error.details.includes(forbiddenTool),
      );
    });
  });
}

test('init 메타데이터가 검색 전용 도구·dontAsk·비실행 경계를 벗어나면 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const unsafeInitializations = [
    initEvent({ tools: ['WebSearch', 'Read'] }),
    initEvent({ permissionMode: 'default' }),
    initEvent({ mcp_servers: [{ name: 'corp', status: 'connected' }] }),
    initEvent({ skills: ['skill-a'] }),
    initEvent({ slash_commands: ['/custom'] }),
    initEvent({ plugin_errors: [{ plugin: 'plugin-a', message: 'load attempted' }] }),
    initEvent({ hooks: [{ event: 'SessionStart' }] }),
  ];

  for (const unsafeInit of unsafeInitializations) {
    await withFakeClaude({
      events: [
        unsafeInit,
        assistantToolUse('toolu-1'),
        userToolResult('toolu-1'),
        successResult(),
      ],
    }, async ({ directory }) => {
      await assert.rejects(
        () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'SECURITY_POLICY',
      );
    });
  }
});

test('safe-mode가 노출하는 설치 플러그인과 기본 에이전트 메타데이터는 실행으로 오인하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const events = successfulSearchEvents({
    init: {
      plugins: [{
        name: 'github',
        path: 'C:\\Users\\tester\\.claude\\plugins\\github',
        source: 'github@claude-plugins-official',
      }],
      agents: ['claude', 'Explore', 'general-purpose', 'Plan'],
    },
  });
  await withFakeClaude({ events }, async ({ directory }) => {
    const result = await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, DOMAIN_JSON);
    assert.equal(result.toolEvidence.byName.WebSearch.success, 1);
  });
});

test('실제 조사 프로세스의 Claude Code 버전도 최소 안정 버전 이상이어야 한다', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const claudeCodeVersion of ['', '2.1.213', '2.1.214-preview.1']) {
    await withFakeClaude({
      events: successfulSearchEvents({
        init: { claude_code_version: claudeCodeVersion },
      }),
    }, async ({ directory }) => {
      await assert.rejects(
        () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'CLI_VERSION' && /2\.1\.214/.test(error.details),
      );
    });
  }
});

test('Claude stream에 hook 실행 이벤트가 나타나면 결과를 폐기한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const hookEvent = {
    type: 'system',
    subtype: 'hook_started',
    hook_id: 'hook-1',
    hook_name: 'SessionStart',
    session_id: 'session-1',
  };
  await withFakeClaude({
    events: [initEvent(), hookEvent, ...successfulSearchEvents().slice(1)],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'SECURITY_POLICY' && /hook/i.test(error.message),
    );
  });
});

test('손상된 JSONL과 최종 result 누락은 BAD_OUTPUT으로 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    stdoutRaw: `${JSON.stringify(initEvent())}\r\nnot-json\r\n`,
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT',
    );
  });
  await withFakeClaude({ events: [initEvent(), assistantToolUse('toolu-1'), userToolResult('toolu-1')] }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT',
    );
  });
});

test('구조화된 Claude 오류 result는 오류 이벤트 자체로 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const events = [initEvent(), {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Authentication required; please sign in',
    errors: ['OAuth token expired'],
    session_id: 'session-1',
  }];
  await withFakeClaude({ events, stderr: 'harmless diagnostic', exitCode: 1 }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'AUTH'
        && /OAuth token expired/.test(error.details)
        && /harmless diagnostic/.test(error.details),
    );
  });
});

test('성공 subtype의 API 오류도 상태 코드와 result 내용으로 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const [apiStatus, expectedCode] of [
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [503, 'SERVICE'],
  ]) {
    const events = [initEvent(), {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: `Claude API error ${apiStatus}`,
      api_error_status: apiStatus,
      session_id: 'session-1',
    }];
    await withFakeClaude({ events, exitCode: 1 }, async ({ directory }) => {
      await assert.rejects(
        () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === expectedCode && error.details.includes(String(apiStatus)),
      );
    });
  }

  const connectionEvents = [initEvent(), {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'API Error: Unable to connect to API (ECONNREFUSED)',
    api_error_status: null,
    session_id: 'session-1',
  }];
  await withFakeClaude({ events: connectionEvents, exitCode: 1 }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'TIMEOUT' && /Unable to connect/.test(error.details),
    );
  });
});

test('조사 호출에서 필수 보안 옵션을 거부하면 CLI_VERSION으로 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    stderr: 'Unknown option: --safe-mode',
    exitCode: 1,
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'CLI_VERSION' && /safe-mode/.test(error.details),
    );
  });
});

test('응답 내부 ENOENT 문자열을 CLI 미설치로 오분류하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    events: successfulSearchEvents({ result: 'Internal ENOENT while reading cache' }),
  }, async ({ directory }) => {
    const result = await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, 'Internal ENOENT while reading cache');
  });
});

test('Windows에서 없는 Claude 명령은 로캘과 무관하게 CLI_NOT_FOUND로 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-claude-cli-'));
  const originalBin = process.env.CLAUDE_CLI_BIN;
  try {
    await prepareResearchWorkspace(directory);
    process.env.CLAUDE_CLI_BIN = 'definitely-missing-claude-cli-command';
    await assert.rejects(
      () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'CLI_NOT_FOUND' && /PATH/.test(error.message),
    );
  } finally {
    if (originalBin === undefined) delete process.env.CLAUDE_CLI_BIN;
    else process.env.CLAUDE_CLI_BIN = originalBin;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows 사용자 지정 CLI 경로는 공백·한글·메타문자를 안전하게 전달한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({ events: successfulSearchEvents() }, async ({ directory }) => {
    const result = await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, DOMAIN_JSON);
  }, {
    absoluteBin: true,
    binSubdirectory: '회사 Claude & CLI',
  });
});

test('Claude 자식 환경은 사내 인증·프록시 설정을 보존하고 자동 동기화·영속성은 막는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const names = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'HTTPS_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'CLAUDE_CODE_SYNC_PLUGIN_INSTALL',
    'CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS',
    'CLAUDE_CODE_SYNC_SKILLS',
    'CLAUDE_CODE_SYNC_SKILLS_INSTALL_TIMEOUT_MS',
    'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
    'NO_COLOR',
    'CLAUDE_CODE_SAFE_MODE',
    'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
    'CLAUDE_CODE_DISABLE_ARTIFACT',
    'CLAUDE_CODE_DISABLE_AGENT_VIEW',
    'ENABLE_CLAUDEAI_MCP_SERVERS',
    'DISABLE_AUTOUPDATER',
  ];
  const originals = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ANTHROPIC_API_KEY = 'company-gateway-key';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'company-oauth-token';
  process.env.CLAUDE_CONFIG_DIR = 'C:\\Company\\ClaudeConfig';
  process.env.ANTHROPIC_BASE_URL = 'https://claude-gateway.corp.example';
  process.env.HTTPS_PROXY = 'https://proxy.corp.example:8443';
  process.env.NODE_EXTRA_CA_CERTS = 'C:\\Company\\corp-ca.pem';
  process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL = '1';
  process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS = '60000';
  process.env.CLAUDE_CODE_SYNC_SKILLS = '1';
  process.env.CLAUDE_CODE_SYNC_SKILLS_INSTALL_TIMEOUT_MS = '60000';
  process.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE = '1';
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '0';
  try {
    await withFakeClaude({
      captureEnv: names,
      events: successfulSearchEvents(),
    }, async ({ directory, invocation }) => {
      await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
      const observed = await readInvocation(invocation);
      assert.equal(observed.env.ANTHROPIC_API_KEY, 'company-gateway-key');
      assert.equal(observed.env.CLAUDE_CODE_OAUTH_TOKEN, 'company-oauth-token');
      assert.equal(observed.env.CLAUDE_CONFIG_DIR, 'C:\\Company\\ClaudeConfig');
      assert.equal(observed.env.ANTHROPIC_BASE_URL, 'https://claude-gateway.corp.example');
      assert.equal(observed.env.HTTPS_PROXY, 'https://proxy.corp.example:8443');
      assert.equal(observed.env.NODE_EXTRA_CA_CERTS, 'C:\\Company\\corp-ca.pem');
      assert.equal(observed.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL, null);
      assert.equal(observed.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS, null);
      assert.equal(observed.env.CLAUDE_CODE_SYNC_SKILLS, null);
      assert.equal(observed.env.CLAUDE_CODE_SYNC_SKILLS_INSTALL_TIMEOUT_MS, null);
      assert.equal(observed.env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, null);
      assert.equal(observed.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, null);
      assert.equal(observed.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
      assert.equal(observed.env.NO_COLOR, '1');
      assert.equal(observed.env.CLAUDE_CODE_SAFE_MODE, '1');
      assert.equal(observed.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1');
      assert.equal(observed.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
      assert.equal(observed.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
      assert.equal(observed.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, '1');
      assert.equal(observed.env.CLAUDE_CODE_DISABLE_ARTIFACT, '1');
      assert.equal(observed.env.CLAUDE_CODE_DISABLE_AGENT_VIEW, '1');
      assert.equal(observed.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
      assert.equal(observed.env.DISABLE_AUTOUPDATER, '1');
    });
  } finally {
    for (const name of names) {
      if (originals[name] === undefined) delete process.env[name];
      else process.env[name] = originals[name];
    }
  }
});

test('사전 점검은 --version 하나로 Claude Code 버전을 확인한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    version: { versionText: '2.1.214 (Claude Code)' },
  }, async ({ directory, invocation }) => {
    const result = await preflightClaudeCli({ cwd: directory, timeoutMs: 5000 });
    assert.equal(result.version, '2.1.214');
    assert.equal(result.minimumVersion, '2.1.214');
    const observed = await readInvocation(invocation);
    assert.deepEqual(observed.args, ['--version']);
    assert.equal(observed.stdin, '');
  });
});

test('사전 점검은 사내 배너의 다른 버전이 아닌 Claude Code 버전을 사용한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    version: { versionText: 'Security Agent 8.2.1\r\n2.1.220 (Claude Code)' },
  }, async ({ directory }) => {
    const result = await preflightClaudeCli({ cwd: directory, timeoutMs: 5000 });
    assert.equal(result.version, '2.1.220');
  });
});

test('사전 점검은 최소 버전 미만과 최소 버전의 prerelease를 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const versionText of ['2.1.213 (Claude Code)', '2.1.214-preview.1 (Claude Code)']) {
    await withFakeClaude({
      version: { versionText },
    }, async ({ directory }) => {
      await assert.rejects(
        () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'CLI_VERSION'
          && error.details.includes(versionText.split(' ')[0])
          && /2\.1\.214/.test(error.details),
      );
    });
  }
});

test('사전 점검 시작 시간 초과는 구버전이 아닌 CLI_STARTUP_TIMEOUT으로 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    version: { delayMs: 20000, versionText: '2.1.214 (Claude Code)' },
  }, async ({ directory }) => {
    await assert.rejects(
      () => preflightClaudeCli({ cwd: directory, timeoutMs: 100 }),
      (error) => error.code === 'CLI_STARTUP_TIMEOUT',
    );
  });
});

test('Windows 시간 초과 시 Claude 프로세스 트리를 종료하고 TIMEOUT을 반환한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({ delayMs: 20000, events: successfulSearchEvents() }, async ({ directory }) => {
    const startedAt = Date.now();
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 100 }),
      (error) => error.code === 'TIMEOUT',
    );
    assert.ok(Date.now() - startedAt < 8000);
  });
});

test('중단 신호는 Claude 프로세스를 정리한 뒤 ABORTED를 반환한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({ delayMs: 20000, events: successfulSearchEvents() }, async ({ directory }) => {
    const controller = new AbortController();
    const call = callClaudeCli('시험', {
      cwd: directory,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(call, (error) => error.code === 'ABORTED');
  });
});

test('활성 Claude 호출 중 전체 제한 신호가 오면 RUN_TIMEOUT 원인을 보존한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({ delayMs: 20000, events: successfulSearchEvents() }, async ({ directory }) => {
    const controller = new AbortController();
    const call = callClaudeCli('시험', {
      cwd: directory,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    const reason = new Error('전체 실행 제한 시험');
    reason.code = 'RUN_TIMEOUT';
    setTimeout(() => controller.abort(reason), 100);
    await assert.rejects(call, (error) => error.code === 'RUN_TIMEOUT');
  });
});
