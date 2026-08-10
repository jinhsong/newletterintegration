import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  __stopProcessTreeForTest,
  ClaudeCliError,
  callClaudeCli,
  createProcessCleanupError,
  parseCliVersion,
  parseClaudeStream,
  prepareResearchWorkspace,
  preflightClaudeCli,
  preflightTimeoutMs,
  resolveForcedStopError,
  resolveWindowsSystemExecutable,
  retryMax,
  searchQueryFingerprint,
  sensitiveEnvironmentVariableNames,
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
  '--max-turns', '32',
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
      query: options.query ?? '수출통제 동향',
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
if (selected.delayMs) {
  const stopFile = new URL('./stop-requested', import.meta.url);
  const deadline = Date.now() + selected.delayMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(stopFile);
      await fs.writeFile(new URL('./stop-acknowledged', import.meta.url), '', 'utf8');
      process.exit(0);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
}
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
  const stopFile = path.join(binDirectory, 'stop-requested');
  const stopAcknowledgedFile = path.join(binDirectory, 'stop-acknowledged');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'Path';
  const originalPath = process.env[pathKey];
  const originalBin = process.env.CLAUDE_CLI_BIN;
  const originalModel = process.env.CLAUDE_CLI_MODEL;
  const canStillBeDelayed = Boolean(
    behavior?.delayMs || behavior?.research?.delayMs || behavior?.version?.delayMs,
  );
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
    // A restricted enterprise endpoint can deny taskkill. The production code
    // correctly fails closed for an opaque .cmd wrapper; ask this test-only
    // fake driver to exit cooperatively so no descendant can leak into another
    // test or keep its temporary working directory locked.
    try { await fs.writeFile(stopFile, '', 'utf8'); } catch {}
    if (canStillBeDelayed) {
      const stopDeadline = Date.now() + 750;
      while (Date.now() < stopDeadline) {
        try {
          await fs.access(stopAcknowledgedFile);
          break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await stopAllClaudeProcesses();
    process.env[pathKey] = originalPath;
    if (originalBin === undefined) delete process.env.CLAUDE_CLI_BIN;
    else process.env.CLAUDE_CLI_BIN = originalBin;
    if (originalModel === undefined) delete process.env.CLAUDE_CLI_MODEL;
    else process.env.CLAUDE_CLI_MODEL = originalModel;
    await fs.rm(rootDirectory, {
      recursive: true,
      force: true,
      maxRetries: 40,
      retryDelay: 50,
    });
  }
}

function matchesForcedStopError(error, expectedCode) {
  if (error?.code === expectedCode) return true;
  return error?.code === 'PROCESS_CLEANUP'
    && String(error.details || '').includes(`원래 오류 (${expectedCode}):`)
    && /\.cmd\/\.bat 래퍼/.test(String(error.details || ''));
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

test('전체 실행 제한은 기본 90분이며 안전한 정수 환경변수만 반영한다', () => {
  const original = process.env.CLAUDE_RUN_TIMEOUT_MS;
  try {
    delete process.env.CLAUDE_RUN_TIMEOUT_MS;
    assert.equal(totalTimeoutMs(), 5400000);
    process.env.CLAUDE_RUN_TIMEOUT_MS = '3600000';
    assert.equal(totalTimeoutMs(), 3600000);
    process.env.CLAUDE_RUN_TIMEOUT_MS = '10minutes';
    assert.equal(totalTimeoutMs(), 5400000);
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

test('검색어 다양성 지문은 순서·반복·장식 숫자는 무시하고 규정 번호는 보존한다', () => {
  assert.equal(
    searchQueryFingerprint('North America tariff official search 1'),
    searchQueryFingerprint('tariff official North America search 2'),
  );
  assert.equal(
    searchQueryFingerprint('tariff tariff official North America'),
    searchQueryFingerprint('North America official tariff'),
  );
  assert.notEqual(
    searchQueryFingerprint('US tariff Section 232'),
    searchQueryFingerprint('US tariff Section 301'),
  );
  assert.notEqual(
    searchQueryFingerprint('electronics HS 8517 tariff'),
    searchQueryFingerprint('electronics HS 8542 tariff'),
  );
  assert.notEqual(
    searchQueryFingerprint('electronics HS 85.17 tariff'),
    searchQueryFingerprint('electronics HS 85.42 tariff'),
  );
  assert.notEqual(
    searchQueryFingerprint('15 CFR 744.21 export control'),
    searchQueryFingerprint('15 CFR 746.8 export control'),
  );
  assert.notEqual(
    searchQueryFingerprint('15CFR744.21 export control'),
    searchQueryFingerprint('15CFR744.8 export control'),
  );
  assert.notEqual(
    searchQueryFingerprint('electronics HS85.17 tariff'),
    searchQueryFingerprint('electronics HS85.42 tariff'),
  );
  assert.equal(
    searchQueryFingerprint('North America tariff search1'),
    searchQueryFingerprint('North America tariff search2'),
  );
  assert.notEqual(
    searchQueryFingerprint('NVIDIA H100 restrictions'),
    searchQueryFingerprint('NVIDIA H200 restrictions'),
  );
  assert.equal(
    searchQueryFingerprint('1 Section 232 tariff'),
    searchQueryFingerprint('2 Section 232 tariff'),
  );
  assert.equal(searchQueryFingerprint('1'), searchQueryFingerprint('6'));
  assert.equal(searchQueryFingerprint('1'), '');
});

test('stream-json 심층 검색 검증도 장식만 바꾼 query를 중복으로 거부한다', () => {
  const streamFor = (queries) => {
    const events = [initEvent()];
    queries.forEach((query, index) => {
      const id = `fingerprint-${index + 1}`;
      const official = index < 3;
      events.push(assistantToolUse(id, 'WebSearch', {
        query,
        ...(official ? { allowed_domains: ['agency.gov'] } : {}),
      }));
      const resultUrl = official
        ? `https://agency.gov/fingerprint-${index + 1}`
        : `https://example.com/fingerprint-${index + 1}`;
      events.push(userToolResult(id, {
        query,
        content: resultUrl,
        structuredResult: {
          query,
          results: [{
            tool_use_id: id,
            content: [{
              title: '검색 결과',
              url: resultUrl,
            }],
          }],
          searchCount: 1,
        },
      }));
    });
    events.push(successResult());
    return events.map((event) => JSON.stringify(event)).join('\n');
  };
  const options = {
    minimumWebSearchSuccesses: 6,
    minimumOfficialSearches: 3,
    minimumBroadSearches: 3,
    requireOfficialAndBroadSearch: true,
    officialDomainAllowlist: ['agency.gov'],
  };
  const queries = [
    'official law gazette',
    'official implementation guidance',
    'official product HS 8517 measure',
    'major media policy news',
    'local language industry news',
    'Korean company supply chain impact',
  ];
  assert.equal(parseClaudeStream(streamFor(queries), options).toolEvidence.totalSuccess, 6);

  const duplicateQueries = [...queries];
  duplicateQueries[1] = 'gazette law official 2';
  assert.throws(
    () => parseClaudeStream(streamFor(duplicateQueries), options),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /서로 다른 query 5개/.test(error.details),
  );

  const numericOnlyQueries = [...queries];
  numericOnlyQueries[5] = '123';
  assert.throws(
    () => parseClaudeStream(streamFor(numericOnlyQueries), options),
    (error) => error.code === 'SEARCH_INCOMPLETE' && /서로 다른 query 5개/.test(error.details),
  );
});

test('근거 URL은 실제 structured results의 URL 필드만 검색별로 보존한다', () => {
  const id = 'structured-grounding';
  const events = [
    initEvent(),
    assistantToolUse(id, 'WebSearch', {
      query: 'official evidence query https://query-injection.example.net/not-evidence',
    }),
    userToolResult(id, {
      content: '본문에만 있는 URL https://content-injection.example.net/not-evidence',
      structuredResult: {
        query: 'official evidence query https://query-injection.example.net/not-evidence',
        metadata: { url: 'https://metadata-injection.example.net/not-evidence' },
        results: [{
          title: '실제 결과',
          url: 'https://agency.gov/real-rule#section',
          metadata: { url: 'https://nested-metadata.example.net/not-evidence' },
          content: [{
            href: 'https://agency.gov/implementation',
            snippet: '문자열 URL https://snippet-injection.example.net/not-evidence',
            related: [{ url: 'https://related-injection.example.net/not-evidence' }],
          }],
        }],
        searchCount: 1,
      },
    }),
    successResult(),
  ];
  const parsed = parseClaudeStream(events.map((event) => JSON.stringify(event)).join('\n'));
  assert.deepEqual(parsed.groundingUrls, [
    'https://agency.gov/real-rule',
    'https://agency.gov/implementation',
  ]);
  assert.deepEqual(parsed.groundingSearches, [{
    toolUseId: id,
    query: 'official evidence query https://query-injection.example.net/not-evidence',
    mode: 'broad',
    allowedDomains: [],
    blockedDomains: [],
    urls: [
      'https://agency.gov/real-rule',
      'https://agency.gov/implementation',
    ],
    officialUrls: [],
  }]);
});

test('실제 결과 URL이 없거나 공식 allowed_domains와 불일치하면 검색 성공으로 세지 않는다', () => {
  const streamFor = (input, structuredResult) => [
    initEvent(),
    assistantToolUse('evidence-check', 'WebSearch', input),
    userToolResult('evidence-check', {
      content: 'https://agency.gov/content-only',
      structuredResult,
    }),
    successResult(),
  ].map((event) => JSON.stringify(event)).join('\n');

  assert.throws(
    () => parseClaudeStream(streamFor(
      { query: 'broad evidence query' },
      {
        query: 'broad evidence query',
        results: [{ title: 'URL 없는 결과', snippet: 'https://agency.gov/snippet-only' }],
        searchCount: 1,
      },
    )),
    (error) => error.code === 'SEARCH_FAILED' && /실제 검색 결과/.test(error.details),
  );

  assert.throws(
    () => parseClaudeStream(streamFor(
      { query: 'official evidence query', allowed_domains: ['agency.gov'] },
      {
        query: 'official evidence query',
        results: [{ title: '불일치 결과', url: 'https://news.example.com/report' }],
        searchCount: 1,
      },
    ), { officialDomainAllowlist: ['agency.gov'] }),
    (error) => error.code === 'SEARCH_FAILED' && /allowed_domains/.test(error.details),
  );
});

test('blocked_domains 검색은 broad로 세지 않고 엄격 검색에서는 즉시 거부한다', () => {
  const events = [
    initEvent(),
    assistantToolUse('blocked-search', 'WebSearch', {
      query: 'filtered research query',
      blocked_domains: ['blocked.example.com'],
    }),
    userToolResult('blocked-search', {
      query: 'filtered research query',
      structuredResult: {
        query: 'filtered research query',
        results: [{ title: '결과', url: 'https://agency.gov/result' }],
        searchCount: 1,
      },
    }),
    successResult(),
  ];
  const stream = events.map((event) => JSON.stringify(event)).join('\n');
  const parsed = parseClaudeStream(stream);
  assert.equal(parsed.toolEvidence.byName.WebSearch.broad, 0);
  assert.equal(parsed.toolEvidence.byName.WebSearch.queries[0].mode, 'blocked');
  assert.throws(
    () => parseClaudeStream(stream, {
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: ['agency.gov'],
    }),
    (error) => error.code === 'BAD_OUTPUT' && /blocked_domains/.test(error.message),
  );
});

test('stream session_id 불일치와 허용 목록 밖 이벤트·subtype·content block을 거부한다', () => {
  const mismatch = successfulSearchEvents();
  mismatch[2].session_id = 'session-2';
  assert.throws(
    () => parseClaudeStream(mismatch.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SECURITY_POLICY' && /session_id/.test(error.message),
  );

  const finalMismatch = successfulSearchEvents({
    resultOverrides: { session_id: 'session-final-mismatch' },
  });
  assert.throws(
    () => parseClaudeStream(finalMismatch.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SECURITY_POLICY' && /session_id/.test(error.message),
  );

  for (const suspiciousEvent of [
    { type: 'file_persist_event', path: 'report.txt', session_id: 'session-1' },
    { type: 'telemetry_notice', state: 'active', session_id: 'session-1' },
    { type: 'system', subtype: 'background_job_started', session_id: 'session-1' },
    { type: 'system', subtype: 'status_update', session_id: 'session-1' },
    { type: 'tool_invocation_delta', tool_name: 'Write', session_id: 'session-1' },
    { type: 'filesPersisted', path: 'report.txt', session_id: 'session-1' },
    { type: 'assistant', subtype: 'backgroundTaskStarted', session_id: 'session-1', message: { content: [] } },
  ]) {
    const events = successfulSearchEvents();
    events.splice(-1, 0, suspiciousEvent);
    assert.throws(
      () => parseClaudeStream(events.map((event) => JSON.stringify(event)).join('\n')),
      (error) => error.code === 'SECURITY_POLICY',
    );
  }

  const suspiciousBlock = successfulSearchEvents();
  suspiciousBlock[1].message.content.unshift({ type: 'file_write', path: 'report.txt' });
  assert.throws(
    () => parseClaudeStream(suspiciousBlock.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SECURITY_POLICY',
  );

  const unknownAssistantBlock = successfulSearchEvents();
  unknownAssistantBlock[1].message.content.unshift({ type: 'citation', url: 'https://agency.gov/rule' });
  assert.throws(
    () => parseClaudeStream(unknownAssistantBlock.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SECURITY_POLICY' && /content block/.test(error.message),
  );

  const unknownUserBlock = successfulSearchEvents();
  unknownUserBlock[2].message.content.unshift({ type: 'search_result', value: 'unexpected' });
  assert.throws(
    () => parseClaudeStream(unknownUserBlock.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SECURITY_POLICY' && /content block/.test(error.message),
  );

  const unknownResultSubtype = successfulSearchEvents({
    resultOverrides: { subtype: 'success_with_unverified_side_effects' },
  });
  assert.throws(
    () => parseClaudeStream(unknownResultSubtype.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SECURITY_POLICY' && /result subtype/.test(error.message),
  );

  for (const [field, value] of [
    ['files_persisted', [{ path: 'report.txt' }]],
    ['filesPersisted', [{ path: 'report.txt' }]],
    ['fileChanges', [{ path: 'report.txt' }]],
    ['backgroundTasks', [{ id: 'task-1' }]],
    ['future_metadata', { active: true }],
  ]) {
    const persistedResult = successfulSearchEvents({
      resultOverrides: { [field]: value },
    });
    assert.throws(
      () => parseClaudeStream(persistedResult.map((event) => JSON.stringify(event)).join('\n')),
      (error) => error.code === 'SECURITY_POLICY'
        && /최종 result/.test(error.message)
        && error.details.includes(field),
    );
  }

  const currentOptionalMetadata = successfulSearchEvents({
    resultOverrides: {
      fast_mode_state: 'off',
      origin: { kind: 'human' },
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      ttft_ms: 12.5,
    },
  });
  assert.doesNotThrow(
    () => parseClaudeStream(currentOptionalMetadata.map((event) => JSON.stringify(event)).join('\n')),
  );

  for (const resultOverrides of [
    { fast_mode_state: 'turbo' },
    { ttft_ms: -1 },
    { origin: { kind: 'task-notification' } },
    { origin: { kind: 'human', server: 'unexpected' } },
    { deferred_tool_use: { id: 'toolu-1', name: 'Write', input: {} } },
    { stop_reason: 'tool_deferred' },
    { terminal_reason: 'hook_stopped' },
  ]) {
    const unsafeMetadata = successfulSearchEvents({ resultOverrides });
    assert.throws(
      () => parseClaudeStream(unsafeMetadata.map((event) => JSON.stringify(event)).join('\n')),
      (error) => ['BAD_OUTPUT', 'SECURITY_POLICY'].includes(error.code),
    );
  }
});

test('공식 rate_limit_event는 엄격히 검증하고 경고와 거부를 구분한다', () => {
  const rateEvent = (status, overrides = {}) => {
    const { rate_limit_info: infoOverrides = {}, ...eventOverrides } = overrides;
    return {
      type: 'rate_limit_event',
      rate_limit_info: {
        status,
        resetsAt: 1_800_000_000,
        utilization: 0.85,
        ...infoOverrides,
      },
      uuid: 'rate-event-1',
      session_id: 'session-1',
      ...eventOverrides,
    };
  };

  const warningEvents = successfulSearchEvents();
  warningEvents.splice(1, 0, rateEvent('allowed_warning'));
  const warningResult = parseClaudeStream(
    warningEvents.map((event) => JSON.stringify(event)).join('\n'),
  );
  assert.match(warningResult.warnings.join('\n'), /사용량 제한 경고/);

  const allowedEvents = successfulSearchEvents();
  allowedEvents.splice(1, 0, rateEvent('allowed'));
  assert.doesNotThrow(
    () => parseClaudeStream(allowedEvents.map((event) => JSON.stringify(event)).join('\n')),
  );

  const rejectedEvents = successfulSearchEvents();
  rejectedEvents.splice(1, 0, rateEvent('rejected'));
  assert.throws(
    () => parseClaudeStream(rejectedEvents.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'RATE_LIMIT',
  );

  for (const invalidEvent of [
    rateEvent('unknown'),
    rateEvent('allowed', { rate_limit_info: { utilization: -1 } }),
    rateEvent('allowed', { backgroundTask: true }),
  ]) {
    const events = successfulSearchEvents();
    events.splice(1, 0, invalidEvent);
    assert.throws(
      () => parseClaudeStream(events.map((event) => JSON.stringify(event)).join('\n')),
      (error) => ['BAD_OUTPUT', 'SECURITY_POLICY'].includes(error.code),
    );
  }
});

test('공개 URL과 도메인은 동일한 예약·비공개 suffix 정책을 적용한다', () => {
  const badDomain = [
    initEvent(),
    assistantToolUse('bad-domain', 'WebSearch', {
      query: 'reserved suffix query',
      allowed_domains: ['agency.test'],
    }),
    successResult(),
  ];
  assert.throws(
    () => parseClaudeStream(badDomain.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'BAD_OUTPUT' && /공개 hostname/.test(error.message),
  );

  const badResult = [
    initEvent(),
    assistantToolUse('bad-result', 'WebSearch', { query: 'reserved result query' }),
    userToolResult('bad-result', {
      structuredResult: {
        query: 'reserved result query',
        results: [{ title: '예약 도메인', url: 'https://agency.test/rule' }],
        searchCount: 1,
      },
    }),
    successResult(),
  ];
  assert.throws(
    () => parseClaudeStream(badResult.map((event) => JSON.stringify(event)).join('\n')),
    (error) => error.code === 'SEARCH_FAILED' && /공개 HTTPS URL/.test(error.details),
  );
});

test('민감 환경 진단은 변수 이름만 분류하고 값은 반환하지 않는다', () => {
  const environment = {
    ANTHROPIC_API_KEY: 'secret-api-value',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret-oauth-value',
    ANTHROPIC_BASE_URL: 'https://enterprise.example.com',
    HTTPS_PROXY: 'https://proxy.example.com',
    NODE_EXTRA_CA_CERTS: 'C:\\corp\\ca.pem',
    PATH: 'C:\\bin',
  };
  const names = sensitiveEnvironmentVariableNames(environment);
  assert.deepEqual(names, [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'HTTPS_PROXY',
    'NODE_EXTRA_CA_CERTS',
  ]);
  assert.equal(JSON.stringify(names).includes('secret-api-value'), false);
  assert.equal(names.includes('PATH'), false);
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

test('Windows native 실행 파일도 taskkill 거부 시 루트 종료만으로 트리 종료를 단정하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const child = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const startedAt = Date.now();
  try {
    const cleanup = await __stopProcessTreeForTest(child, process.execPath, {
      code: 5,
      details: 'ERROR: Access is denied.',
    });
    assert.equal(cleanup.closed, true);
    assert.equal(cleanup.treeConfirmed, false);
    assert.match(cleanup.details, /native CLI 루트 프로세스는 종료했지만 하위 프로세스 트리의 종료는 확인할 수 없/);
    assert.ok(Date.now() - startedAt < 3000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
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
      byName: {
        WebSearch: {
          count: 1,
          success: 1,
          fail: 0,
          official: 0,
          broad: 1,
          queries: [{ query: '수출통제 동향', mode: 'broad', allowedDomains: [] }],
        },
      },
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
    assert.deepEqual(result.toolEvidence.byName.WebSearch, {
      count: 2,
      success: 2,
      fail: 0,
      official: 0,
      broad: 2,
      queries: [
        { query: '수출통제 동향', mode: 'broad', allowedDomains: [] },
        { query: '관세 동향', mode: 'broad', allowedDomains: [] },
      ],
    });
    assert.deepEqual(result.groundingUrls.sort(), [
      'https://a.gov/rule',
      'https://b.gov/rule',
    ]);
  });
});

test('카테고리 조사는 서로 다른 공식기관 3회와 일반 동향 3회를 모두 증명한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const events = [initEvent()];
  const queryPerspectives = [
    'official North America tariff law gazette',
    'official North America customs implementation guidance',
    'official North America electronics product HS measure',
    'North America tariff major media policy news',
    'North America tariff local industry news',
    'North America tariff Korean supply chain impact',
  ];
  for (let index = 0; index < 6; index += 1) {
    const official = index < 3;
    const id = `toolu-${official ? 'official' : 'broad'}-${index + 1}`;
    const query = queryPerspectives[index];
    events.push(assistantToolUse(id, 'WebSearch', {
      query,
      ...(official ? { allowed_domains: [index === 0 ? 'Whitehouse.gov' : 'cbp.gov'] } : {}),
    }));
    const resultUrl = official
      ? `https://${index === 0 ? 'whitehouse.gov' : 'cbp.gov'}/result-${index + 1}`
      : `https://example.com/result-${index + 1}`;
    events.push(userToolResult(id, {
      query,
      content: resultUrl,
      structuredResult: {
        query,
        results: [{
          tool_use_id: id,
          content: [{ title: '검색 결과', url: resultUrl }],
        }],
        searchCount: 1,
      },
    }));
  }
  events.push(successResult());
  await withFakeClaude({ events }, async ({ directory }) => {
    const result = await callClaudeCli('시험', {
      cwd: directory,
      timeoutMs: 5000,
      minimumWebSearchSuccesses: 6,
      minimumOfficialSearches: 3,
      minimumBroadSearches: 3,
      requireOfficialAndBroadSearch: true,
      officialDomainAllowlist: ['whitehouse.gov', 'cbp.gov'],
    });
    assert.equal(result.toolEvidence.byName.WebSearch.official, 3);
    assert.equal(result.toolEvidence.byName.WebSearch.broad, 3);
    assert.deepEqual(
      result.toolEvidence.byName.WebSearch.queries.map((entry) => entry.mode),
      ['official', 'official', 'official', 'broad', 'broad', 'broad'],
    );
    assert.deepEqual(result.toolEvidence.byName.WebSearch.queries[0].allowedDomains, ['whitehouse.gov']);
  });
});

test('총 6회여도 공식 검색이 부족하거나 query가 중복되면 심층 조사로 인정하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const deepEvents = (officialCount, duplicateOfficial = false) => {
    const events = [initEvent()];
    const officialQueries = [
      'official law gazette',
      'official implementation guidance',
      'official product HS analysis',
    ];
    const broadQueries = [
      'major media policy news',
      'local language industry news',
      'Korean company supply chain impact',
      'additional regional market analysis',
    ];
    let officialIndex = 0;
    let broadIndex = 0;
    for (let index = 0; index < 6; index += 1) {
      const official = index < officialCount;
      const id = `deep-${official ? 'official' : 'broad'}-${index + 1}`;
      const query = duplicateOfficial && index === 1
        ? '  gazette---law---official---2  '
        : (official ? officialQueries[officialIndex++] : broadQueries[broadIndex++]);
      events.push(assistantToolUse(id, 'WebSearch', {
        query,
        ...(official ? { allowed_domains: ['agency.gov'] } : {}),
      }));
      const resultUrl = official
        ? `https://agency.gov/deep-${index + 1}`
        : `https://example.com/deep-${index + 1}`;
      events.push(userToolResult(id, {
        query,
        content: resultUrl,
        structuredResult: {
          query,
          results: [{
            tool_use_id: id,
            content: [{ title: '검색 결과', url: resultUrl }],
          }],
          searchCount: 1,
        },
      }));
    }
    events.push(successResult());
    return events;
  };
  const options = (directory) => ({
    cwd: directory,
    timeoutMs: 5000,
    minimumWebSearchSuccesses: 6,
    minimumOfficialSearches: 3,
    minimumBroadSearches: 3,
    requireOfficialAndBroadSearch: true,
    officialDomainAllowlist: ['agency.gov'],
  });

  await withFakeClaude({ events: deepEvents(2) }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', options(directory)),
      (error) => error.code === 'SEARCH_INCOMPLETE' && /공식기관 검색 2회/.test(error.details),
    );
  });

  await withFakeClaude({ events: deepEvents(3, true) }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', options(directory)),
      (error) => error.code === 'SEARCH_INCOMPLETE' && /서로 다른 query 5개/.test(error.details),
    );
  });
});

test('동일 query 반복, 공식검색 누락, query 불일치와 잘못된 공식 도메인을 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const resultEvent = (id, query) => userToolResult(id, {
    content: 'https://agency.gov/result',
    structuredResult: {
      query,
      results: [{
        tool_use_id: id,
        content: [{ title: '검색 결과', url: 'https://agency.gov/result' }],
      }],
      searchCount: 1,
    },
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('official', 'WebSearch', { query: 'Same Query', allowed_domains: ['agency.gov'] }),
      resultEvent('official', 'Same Query'),
      assistantToolUse('broad', 'WebSearch', { query: '  same---query!!!  ' }),
      resultEvent('broad', '  same---query!!!  '),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', {
        cwd: directory,
        timeoutMs: 5000,
        minimumWebSearchSuccesses: 2,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      }),
      (error) => error.code === 'SEARCH_INCOMPLETE' && /서로 다른 query 1개/.test(error.details),
    );
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('broad-1', 'WebSearch', { query: 'broad query one' }),
      resultEvent('broad-1', 'broad query one'),
      assistantToolUse('broad-2', 'WebSearch', { query: 'broad query two' }),
      resultEvent('broad-2', 'broad query two'),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', {
        cwd: directory,
        timeoutMs: 5000,
        minimumWebSearchSuccesses: 2,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['agency.gov'],
      }),
      (error) => error.code === 'SEARCH_INCOMPLETE' && /공식기관 검색 0회/.test(error.details),
    );
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('mismatch', 'WebSearch', { query: 'requested query' }),
      resultEvent('mismatch', 'different query'),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT' && /query가 일치하지/.test(error.message),
    );
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('bad-domain', 'WebSearch', {
        query: 'official query',
        allowed_domains: ['https://agency.gov/path'],
      }),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT' && /공개 hostname/.test(error.message),
    );
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('untrusted-official', 'WebSearch', {
        query: 'official query',
        allowed_domains: ['reuters.com'],
      }),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', {
        cwd: directory,
        timeoutMs: 5000,
        minimumWebSearchSuccesses: 2,
        requireOfficialAndBroadSearch: true,
        officialDomainAllowlist: ['bis.gov'],
      }),
      (error) => error.code === 'BAD_OUTPUT' && /신뢰 목록 밖/.test(error.message),
    );
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('missing-query', 'WebSearch', { allowed_domains: ['agency.gov'] }),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT' && /query가 없습니다/.test(error.message),
    );
  });

  await withFakeClaude({
    events: [
      initEvent(),
      assistantToolUse('bad-label', 'WebSearch', {
        query: 'official query',
        allowed_domains: ['-agency.gov'],
      }),
      successResult(),
    ],
  }, async ({ directory }) => {
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'BAD_OUTPUT' && /공개 hostname/.test(error.message),
    );
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

test('init 메타데이터가 검색 전용 도구·허용 권한 모드·비실행 경계를 벗어나면 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const unsafeInitializations = [
    initEvent({ tools: ['WebSearch', 'Read'] }),
    initEvent({ permissionMode: 'plan' }),
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

test('회사 정책이 dontAsk를 default로 낮춰도 WebSearch 전용 경계이면 허용한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const events = successfulSearchEvents({
    init: { permissionMode: 'default' },
  });
  await withFakeClaude({ events }, async ({ directory }) => {
    const result = await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, DOMAIN_JSON);
    assert.equal(result.toolEvidence.byName.WebSearch.success, 1);
  });
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
  process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = 'company-managed';
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
      assert.equal(observed.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, 'company-managed');
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

test('실행기는 subprocess credential scrub을 자체 활성화하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const name = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB';
  const original = process.env[name];
  delete process.env[name];
  try {
    await withFakeClaude({
      captureEnv: [name],
      events: successfulSearchEvents(),
    }, async ({ directory, invocation }) => {
      await callClaudeCli('시험', { cwd: directory, timeoutMs: 5000 });
      const observed = await readInvocation(invocation);
      assert.equal(observed.env[name], null);
    });
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test('사전 점검은 --version 하나로 Claude Code 버전을 확인한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    version: { versionText: '2.1.214 (Claude Code)' },
  }, async ({ directory, command, invocation }) => {
    const result = await preflightClaudeCli({ cwd: directory, timeoutMs: 5000 });
    assert.equal(result.version, '2.1.214');
    assert.equal(result.minimumVersion, '2.1.214');
    assert.equal(
      path.resolve(result.executablePath).toLocaleLowerCase('en-US'),
      path.resolve(command).toLocaleLowerCase('en-US'),
    );
    assert.equal(Array.isArray(result.diagnostics.inheritedSensitiveEnvironmentNames), true);
    assert.equal(Array.isArray(result.diagnostics.warnings), true);
    assert.equal(typeof result.diagnostics.executableVerification, 'object');
    assert.equal(result.diagnostics.executableVerification.absolutePathVerified, true);
    assert.equal(
      result.diagnostics.inheritedSensitiveEnvironmentNames.some((name) => name.includes('=')),
      false,
    );
    const observed = await readInvocation(invocation);
    assert.deepEqual(observed.args, ['--version']);
    assert.equal(observed.stdin, '');
  });
});

test('실행 파일 절대경로와 SHA-256 정책은 opt-in으로 검증한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const absoluteName = 'CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN';
  const hashName = 'CLAUDE_CLI_ALLOWED_SHA256';
  const originalAbsolute = process.env[absoluteName];
  const originalHash = process.env[hashName];
  try {
    process.env[absoluteName] = '1';
    delete process.env[hashName];
    await withFakeClaude({ version: { versionText: '2.1.214' } }, async ({ directory }) => {
      await assert.rejects(
        () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'CONFIG' && /절대경로/.test(error.message),
      );
    });

    await withFakeClaude({ version: { versionText: '2.1.214' } }, async ({ directory, command }) => {
      const wrapperHash = createHash('sha256').update(await fs.readFile(command)).digest('hex');
      process.env[hashName] = wrapperHash.toUpperCase();
      await assert.rejects(
        () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'SECURITY_POLICY'
          && /native \.exe\/\.com/.test(error.message)
          && /하위 Node\/JavaScript payload/.test(error.details),
      );

      process.env.CLAUDE_CLI_BIN = process.execPath;
      const expected = createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex');
      process.env[hashName] = expected.toUpperCase();
      const result = await preflightClaudeCli({ cwd: directory, timeoutMs: 5000 });
      assert.deepEqual(result.diagnostics.executableVerification, {
        absolutePathRequired: true,
        absolutePathVerified: true,
        sha256Required: true,
        sha256Verified: true,
      });

      process.env[hashName] = '0'.repeat(64);
      await assert.rejects(
        () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'SECURITY_POLICY' && /SHA-256/.test(error.message),
      );
      process.env[hashName] = 'invalid';
      await assert.rejects(
        () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
        (error) => error.code === 'CONFIG' && /64자리/.test(error.message),
      );
    }, { absoluteBin: true });
  } finally {
    if (originalAbsolute === undefined) delete process.env[absoluteName];
    else process.env[absoluteName] = originalAbsolute;
    if (originalHash === undefined) delete process.env[hashName];
    else process.env[hashName] = originalHash;
  }
});

test('Windows 보조 명령은 PATH와 ComSpec 대신 검증한 절대 System32 경로만 사용한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const originalComSpec = process.env.ComSpec;
  const originalSystemRoot = process.env.SystemRoot;
  try {
    process.env.ComSpec = path.join(os.tmpdir(), 'untrusted-cmd.exe');
    const [cmdPath, explorerPath, taskkillPath] = await Promise.all([
      resolveWindowsSystemExecutable('cmd.exe'),
      resolveWindowsSystemExecutable('explorer.exe'),
      resolveWindowsSystemExecutable('taskkill.exe'),
    ]);
    for (const resolved of [cmdPath, explorerPath, taskkillPath]) {
      assert.equal(path.win32.isAbsolute(resolved), true);
      assert.notEqual(resolved.toLowerCase(), process.env.ComSpec.toLowerCase());
    }
    assert.match(cmdPath, /\\System32\\cmd\.exe$/i);
    assert.match(taskkillPath, /\\System32\\taskkill\.exe$/i);
    assert.match(explorerPath, /\\Windows\\explorer\.exe$/i);
    await assert.rejects(
      () => resolveWindowsSystemExecutable('powershell.exe'),
      (error) => error.code === 'SECURITY_POLICY' && /허용되지 않은/.test(error.message),
    );
    process.env.SystemRoot = path.join(os.tmpdir(), 'FakeWindows');
    await assert.rejects(
      () => resolveWindowsSystemExecutable('cmd.exe'),
      (error) => error.code === 'SECURITY_POLICY' && /표준 Windows 폴더/.test(error.message),
    );
  } finally {
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
  }
});

test('준비 뒤 파일이 생긴 격리 작업 폴더에서는 CLI 실행 전에 중단한다', async () => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workspace-mutation-'));
  const directory = path.join(rootDirectory, 'workspace');
  try {
    await fs.mkdir(directory);
    await prepareResearchWorkspace(directory);
    await fs.writeFile(path.join(directory, 'unexpected.txt'), 'unexpected', 'utf8');
    await assert.rejects(
      () => preflightClaudeCli({ cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'SECURITY_POLICY' && /예상하지 않은 파일/.test(error.message),
    );
  } finally {
    await fs.rm(rootDirectory, { recursive: true, force: true });
  }
});

test('POSIX timeout과 abort는 분리된 프로세스 그룹의 자손까지 종료한다', {
  skip: process.platform === 'win32',
}, async () => {
  const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-posix-tree-'));
  const directory = path.join(rootDirectory, 'workspace');
  const command = path.join(rootDirectory, 'fake-claude');
  const pidFile = path.join(rootDirectory, 'descendant.pid');
  const originalBin = process.env.CLAUDE_CLI_BIN;
  const originalPidFile = process.env.FAKE_DESCENDANT_PID_FILE;
  const originalHash = process.env.CLAUDE_CLI_ALLOWED_SHA256;
  try {
    await fs.mkdir(directory);
    await fs.writeFile(command, [
      '#!/bin/sh',
      'sleep 60 &',
      'descendant=$!',
      'printf "%s\\n" "$descendant" > "$FAKE_DESCENDANT_PID_FILE"',
      'wait "$descendant"',
      '',
    ].join('\n'), 'utf8');
    await fs.chmod(command, 0o700);
    await prepareResearchWorkspace(directory);
    process.env.CLAUDE_CLI_BIN = command;
    process.env.FAKE_DESCENDANT_PID_FILE = pidFile;
    delete process.env.CLAUDE_CLI_ALLOWED_SHA256;

    const processIsAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') return false;
        throw error;
      }
    };
    const waitForDescendantExit = async (pid) => {
      const deadline = Date.now() + 3000;
      while (processIsAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return !processIsAlive(pid);
    };

    for (const mode of ['timeout', 'abort']) {
      await fs.rm(pidFile, { force: true });
      const controller = new AbortController();
      let abortTimer;
      if (mode === 'abort') abortTimer = setTimeout(() => controller.abort(), 200);
      try {
        await assert.rejects(
          () => callClaudeCli('시험', {
            cwd: directory,
            timeoutMs: mode === 'timeout' ? 150 : 5000,
            signal: controller.signal,
          }),
          (error) => error.code === (mode === 'timeout' ? 'TIMEOUT' : 'ABORTED'),
        );
      } finally {
        clearTimeout(abortTimer);
      }
      const descendantPid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
      assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);
      assert.equal(await waitForDescendantExit(descendantPid), true);
    }
  } finally {
    await stopAllClaudeProcesses();
    if (originalBin === undefined) delete process.env.CLAUDE_CLI_BIN;
    else process.env.CLAUDE_CLI_BIN = originalBin;
    if (originalPidFile === undefined) delete process.env.FAKE_DESCENDANT_PID_FILE;
    else process.env.FAKE_DESCENDANT_PID_FILE = originalPidFile;
    if (originalHash === undefined) delete process.env.CLAUDE_CLI_ALLOWED_SHA256;
    else process.env.CLAUDE_CLI_ALLOWED_SHA256 = originalHash;
    await fs.rm(rootDirectory, { recursive: true, force: true });
  }
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

test('사전 점검 시간 초과는 CLI_STARTUP_TIMEOUT을 보존하고 래퍼 정리는 fail-closed 처리한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({
    version: { delayMs: 20000, versionText: '2.1.214 (Claude Code)' },
  }, async ({ directory }) => {
    await assert.rejects(
      () => preflightClaudeCli({ cwd: directory, timeoutMs: 100 }),
      (error) => matchesForcedStopError(error, 'CLI_STARTUP_TIMEOUT'),
    );
  });
});

test('Windows 시간 초과는 TIMEOUT을 보존하고 래퍼 정리는 fail-closed 처리한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeClaude({ delayMs: 20000, events: successfulSearchEvents() }, async ({ directory }) => {
    const startedAt = Date.now();
    await assert.rejects(
      () => callClaudeCli('시험', { cwd: directory, timeoutMs: 100 }),
      (error) => matchesForcedStopError(error, 'TIMEOUT'),
    );
    assert.ok(Date.now() - startedAt < 4000);
  });
});

test('중단 신호는 ABORTED를 보존하고 래퍼 정리는 fail-closed 처리한다', {
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
    await assert.rejects(call, (error) => matchesForcedStopError(error, 'ABORTED'));
  });
});

test('전체 제한 신호는 RUN_TIMEOUT을 보존하고 래퍼 정리는 fail-closed 처리한다', {
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
    await assert.rejects(call, (error) => matchesForcedStopError(error, 'RUN_TIMEOUT'));
  });
});
