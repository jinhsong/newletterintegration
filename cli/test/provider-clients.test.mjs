import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  buildCategoryPrompt,
  domains,
} from '../src/config.mjs';
import {
  CODEX_DISABLED_FEATURES,
  CODEX_SAFE_CONFIG_OVERRIDES,
  CODEX_SAFE_ENABLED_FEATURES,
  callCodexCli,
  codexFeatureArguments,
  codexResearchArguments,
  isChatGptOAuthLoginStatus,
  parseCodexFeatureInventory,
  parseCodexFeatureList,
  parseCodexStream,
  preflightCodexCli,
  prepareCodexResearchWorkspace,
} from '../src/codex-client.mjs';
import {
  callGeminiCli,
  geminiResearchArguments,
  parseGeminiStream,
  preflightGeminiCli,
  prepareGeminiResearchWorkspace,
} from '../src/gemini-client.mjs';
import {
  completeInteractiveOptions,
  normalizeInteractiveLookback,
  normalizeInteractiveProvider,
  shouldPromptForOptions,
} from '../src/interactive-options.mjs';
import {
  providerCatalog,
  resolveProvider,
} from '../src/provider-registry.mjs';

const OFFICIAL_QUERY = 'latest export rule site:agency.gov';
const BROAD_QUERY = 'latest export control industry news';
const OFFICIAL_URL = 'https://agency.gov/rules/2026-1';
const BROAD_URL = 'https://news.example.org/article/2026-1';
const RESPONSE = JSON.stringify({
  domain: 'export',
  insight: '',
  categories: { 미국: [] },
  _searchEvidence: [
    { query: OFFICIAL_QUERY, mode: 'official', urls: [OFFICIAL_URL] },
    { query: BROAD_QUERY, mode: 'broad', urls: [BROAD_URL] },
  ],
});

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function geminiEvents(response = RESPONSE) {
  return [
    { type: 'init', session_id: 'gemini-session', model: 'gemini-enterprise' },
    {
      type: 'tool_use',
      tool_name: 'google_web_search',
      tool_id: 'gemini-official',
      parameters: { query: OFFICIAL_QUERY },
    },
    {
      type: 'tool_result',
      tool_id: 'gemini-official',
      status: 'success',
      output: `Search results for "${OFFICIAL_QUERY}" returned.`,
    },
    {
      type: 'tool_use',
      tool_name: 'google_web_search',
      tool_id: 'gemini-broad',
      parameters: { query: BROAD_QUERY },
    },
    {
      type: 'tool_result',
      tool_id: 'gemini-broad',
      status: 'success',
      output: `Search results for "${BROAD_QUERY}" returned.`,
    },
    { type: 'message', role: 'assistant', content: response, delta: false },
    { type: 'result', status: 'success', stats: { total_tokens: 123 } },
  ];
}

function codexEvents(response = RESPONSE) {
  return [
    { type: 'thread.started', thread_id: 'codex-thread' },
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: { id: 'codex-official', type: 'web_search', action: { type: 'search', query: OFFICIAL_QUERY } },
    },
    {
      type: 'item.updated',
      item: { id: 'codex-official', type: 'web_search', action: { type: 'search', query: OFFICIAL_QUERY } },
    },
    {
      type: 'item.completed',
      item: { id: 'codex-official', type: 'web_search', action: { type: 'search', query: OFFICIAL_QUERY } },
    },
    {
      type: 'item.started',
      item: { id: 'codex-broad', type: 'web_search', action: { type: 'search', query: BROAD_QUERY } },
    },
    {
      type: 'item.completed',
      item: { id: 'codex-broad', type: 'web_search', action: { type: 'search', query: BROAD_QUERY } },
    },
    { type: 'item.started', item: { id: 'codex-plan', type: 'todo_list', items: [] } },
    { type: 'item.updated', item: { id: 'codex-plan', type: 'todo_list', items: [] } },
    { type: 'item.completed', item: { id: 'codex-plan', type: 'todo_list', items: [] } },
    {
      type: 'item.started',
      item: { id: 'codex-answer', type: 'agent_message', text: '', phase: 'final_answer' },
    },
    {
      type: 'item.completed',
      item: { id: 'codex-answer', type: 'agent_message', text: response, phase: 'final_answer' },
    },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
  ];
}

async function withEnvironment(values, worker) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await worker();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeDriverSource(provider) {
  const research = provider === 'gemini' ? geminiEvents() : codexEvents();
  const encoded = Buffer.from(JSON.stringify(research), 'utf8').toString('base64');
  const encodedFeatures = Buffer.from(
    CODEX_DISABLED_FEATURES.map((feature) => [feature, 'stable false'].join(' ')).join('\n'),
    'utf8',
  ).toString('base64');
  return `
import fs from 'node:fs/promises';
const args = process.argv.slice(2);
const mode = process.env.TRADE_TEST_FAKE_MODE || '';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
await fs.appendFile(
  new URL('./invocations.jsonl', import.meta.url),
  JSON.stringify({
    args,
    stdin,
    cwd: process.cwd(),
    env: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
      CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
      CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN ?? null,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? null,
      CODEX_REVOKE_TOKEN_URL_OVERRIDE: process.env.CODEX_REVOKE_TOKEN_URL_OVERRIDE ?? null,
      CODEX_APP_SERVER_LOGIN_CLIENT_ID: process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? null,
      CODEX_AUTHAPI_BASE_URL: process.env.CODEX_AUTHAPI_BASE_URL ?? null,
    },
  }) + '\\n',
  'utf8',
);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('${provider === 'gemini' ? '0.53.0' : 'codex-cli 0.101.0'}\\n');
  process.exit(0);
}
if (${JSON.stringify(provider)} === 'codex' && args.at(-2) === 'features' && args.at(-1) === 'list') {
  let output = Buffer.from('${encodedFeatures}', 'base64').toString('utf8');
  if (mode === 'codex-feature-enabled') output = output.replace(' stable false', ' stable true');
  if (mode === 'codex-unreviewed-feature') output += '\\nfuture_remote_tool stable true';
  process.stdout.write(output + '\\n');
  process.exit(0);
}
if (${JSON.stringify(provider)} === 'codex' && args.length === 2 && args[0] === 'login' && args[1] === 'status') {
  process.stdout.write(mode === 'codex-api-auth' ? 'Logged in using an API key\\n' : 'Logged in using ChatGPT\\n');
  process.exit(0);
}
if (mode === 'rate-limit' || mode === 'auth-error') {
  const failureMessage = mode === 'rate-limit' ? '429 rate limit exceeded' : '401 authentication expired';
  const failures = ${JSON.stringify(provider)} === 'gemini'
    ? [
      { type: 'init', session_id: 'failed', model: 'test' },
      { type: 'error', severity: 'error', message: failureMessage },
      { type: 'result', status: 'error', error: { message: failureMessage } },
    ]
    : [{ type: 'item.completed', item: { id: 'failed', type: 'error', message: failureMessage } }];
  for (const event of failures) process.stdout.write(JSON.stringify(event) + '\\n');
  process.exitCode = 1;
} else {
  const events = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8'));
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
}
`;
}

async function installFakeCli(provider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `trade-provider-${provider}-`));
  const binDirectory = path.join(root, 'bin');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(binDirectory);
  await fs.mkdir(workspace);
  const driver = path.join(binDirectory, `${provider}-driver.mjs`);
  await fs.writeFile(driver, fakeDriverSource(provider), 'utf8');
  let command;
  if (process.platform === 'win32') {
    command = path.join(binDirectory, `${provider}.cmd`);
    await fs.writeFile(
      command,
      `@echo off\r\n"${process.execPath}" "%~dp0${provider}-driver.mjs" %*\r\n`,
      'utf8',
    );
  } else {
    command = path.join(binDirectory, provider);
    await fs.writeFile(
      command,
      `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/${provider}-driver.mjs" "$@"\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
  }
  return {
    root,
    command,
    workspace,
    invocationFile: path.join(binDirectory, 'invocations.jsonl'),
  };
}

async function readInvocations(file) {
  return (await fs.readFile(file, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('대화형 모델·기간 입력은 별칭과 1~168시간 범위를 엄격히 처리한다', async () => {
  assert.equal(normalizeInteractiveProvider(''), 'claude');
  assert.equal(normalizeInteractiveProvider('2'), 'gemini');
  assert.equal(normalizeInteractiveProvider('codex'), 'chatgpt');
  assert.equal(normalizeInteractiveLookback(''), undefined);
  assert.equal(normalizeInteractiveLookback('1'), 1);
  assert.equal(normalizeInteractiveLookback('168'), 168);
  for (const invalid of ['0', '169', '1.5', '-1', '1e2']) {
    assert.throws(() => normalizeInteractiveLookback(invalid), /1~168/);
  }

  const answers = ['잘못된 모델', '2', '0', '48'];
  const output = { isTTY: true, text: '', write(value) { this.text += value; } };
  const result = await completeInteractiveOptions(
    { open: false, depth: 'standard' },
    {
      input: { isTTY: true },
      output,
      readline: { question: async () => answers.shift() },
    },
  );
  assert.equal(result.provider, 'gemini');
  assert.equal(result.lookbackHours, 48);
  assert.match(output.text, /입력 오류:/);
  assert.equal(answers.length, 0);
});

test('빈 입력과 비대화형 실행은 Claude·요일 기본 기간을 보존한다', async () => {
  const answers = ['', ''];
  const output = { isTTY: true, write() {} };
  const interactive = await completeInteractiveOptions(
    { depth: 'standard' },
    {
      input: { isTTY: true },
      output,
      readline: { question: async () => answers.shift() },
    },
  );
  assert.equal(interactive.provider, 'claude');
  assert.equal(interactive.lookbackHours, undefined);

  const nonInteractive = await completeInteractiveOptions(
    { depth: 'standard' },
    { input: { isTTY: false }, output: { isTTY: false } },
  );
  assert.equal(nonInteractive.provider, 'claude');
  assert.equal(nonInteractive.lookbackHours, undefined);
  assert.equal(shouldPromptForOptions({ mockPath: 'fixture.json' }, { isTTY: true }, { isTTY: true }), false);

  const periodOnlyAnswers = ['72'];
  const periodOnly = await completeInteractiveOptions(
    { depth: 'standard', provider: 'gemini' },
    {
      input: { isTTY: true },
      output,
      readline: { question: async () => periodOnlyAnswers.shift() },
    },
  );
  assert.equal(periodOnly.provider, 'gemini');
  assert.equal(periodOnly.lookbackHours, 72);

  const providerOnlyAnswers = ['3'];
  const providerOnly = await completeInteractiveOptions(
    { depth: 'standard', lookbackHours: 36 },
    {
      input: { isTTY: true },
      output,
      readline: { question: async () => providerOnlyAnswers.shift() },
    },
  );
  assert.equal(providerOnly.provider, 'chatgpt');
  assert.equal(providerOnly.lookbackHours, 36);
});

test('공급자 목록과 카테고리 프롬프트가 각 CLI 검색 계약을 사용한다', () => {
  assert.deepEqual(providerCatalog.map((entry) => entry.key), ['claude', 'gemini', 'chatgpt']);
  assert.equal(resolveProvider('chatgpt').executableName, 'codex');
  const domain = domains.find((entry) => entry.key === 'export');
  const unit = domain.units.find((entry) => entry.key === '미국');
  const context = {
    fromStr: '2026-08-10 09:00',
    toStr: '2026-08-11 09:00',
    toISO: '2026-08-11',
  };
  const claude = buildCategoryPrompt(domain, unit, context, { provider: 'claude' });
  const gemini = buildCategoryPrompt(domain, unit, context, { provider: 'gemini' });
  const chatgpt = buildCategoryPrompt(domain, unit, context, { provider: 'chatgpt' });
  assert.match(claude, /WebSearch의 allowed_domains/);
  assert.doesNotMatch(claude, /_searchEvidence/);
  assert.match(gemini, /google_web_search/);
  assert.match(gemini, /site:hostname/);
  assert.match(gemini, /_searchEvidence/);
  assert.doesNotMatch(gemini, /WebSearch의 allowed_domains/);
  assert.match(chatgpt, /ChatGPT\(Codex CLI\).*web_search/);
  assert.match(chatgpt, /_searchEvidence/);
});

test('Codex 사전 점검 계약은 위험 기능 비활성화와 ChatGPT OAuth만 허용한다', () => {
  const featureArgs = codexFeatureArguments();
  assert.deepEqual(featureArgs.slice(-2), ['features', 'list']);
  for (const feature of CODEX_DISABLED_FEATURES) {
    const index = featureArgs.findIndex((value, position) => value === feature && featureArgs[position - 1] === '--disable');
    assert.notEqual(index, -1, `${feature} 비활성화 인수가 없습니다.`);
  }
  const states = parseCodexFeatureList('shell_tool stable false\nview_image experimental true\n');
  assert.equal(states.get('shell_tool'), false);
  assert.equal(states.get('view_image'), true);
  const inventory = parseCodexFeatureInventory(
    'goals stable false\nenable_request_compression under development true\ncollaboration_modes removed true\n',
  );
  assert.deepEqual(inventory.get('goals'), { stage: 'stable', enabled: false });
  assert.deepEqual(
    inventory.get('enable_request_compression'),
    { stage: 'under development', enabled: true },
  );
  assert.ok(CODEX_SAFE_ENABLED_FEATURES.includes('secret_auth_storage'));
  assert.equal(isChatGptOAuthLoginStatus('company banner\nLogged in using ChatGPT\n'), true);
  assert.equal(isChatGptOAuthLoginStatus('Logged in using an API key\n'), false);
  assert.equal(isChatGptOAuthLoginStatus('Logged in using Agent Identity\n'), false);
  assert.equal(
    isChatGptOAuthLoginStatus('Logged in using ChatGPT\nLogged in using an API key\n'),
    false,
  );

  const researchArgs = codexResearchArguments();
  assert.equal(researchArgs.includes('--ignore-rules'), true);
  assert.equal(researchArgs.includes('--ignore-user-config'), true);
  assert.equal(researchArgs.includes('--search'), true);
  for (const override of CODEX_SAFE_CONFIG_OVERRIDES) {
    const index = researchArgs.findIndex((value, position) => (
      value === override && researchArgs[position - 1] === '--config'
    ));
    assert.notEqual(index, -1, `${override} 보안 설정이 없습니다.`);
  }
  assert.deepEqual(researchArgs.slice(-1), ['-']);
});

test('Gemini stream-json은 실제 검색 query와 보고 URL을 1:1 검증한다', () => {
  const envelope = parseGeminiStream(jsonl(geminiEvents()), {
    officialDomainAllowlist: ['agency.gov'],
  });
  assert.equal(envelope.toolEvidence.byName.WebSearch.success, 2);
  assert.deepEqual(envelope.groundingUrls, [OFFICIAL_URL, BROAD_URL]);
  assert.equal(envelope.evidenceKind, 'reported');
  assert.doesNotMatch(envelope.response, /_searchEvidence/);
  assert.equal(JSON.parse(envelope.response).domain, 'export');

  const forbidden = geminiEvents();
  forbidden[1] = { ...forbidden[1], tool_name: 'run_shell_command' };
  assert.throws(
    () => parseGeminiStream(jsonl(forbidden), { officialDomainAllowlist: ['agency.gov'] }),
    (error) => error.code === 'SECURITY_POLICY',
  );
  const mismatched = JSON.stringify({
    ...JSON.parse(RESPONSE),
    _searchEvidence: JSON.parse(RESPONSE)._searchEvidence.map((entry, index) => (
      index === 0 ? { ...entry, query: `${entry.query} changed` } : entry
    )),
  });
  assert.throws(
    () => parseGeminiStream(jsonl(geminiEvents(mismatched)), { officialDomainAllowlist: ['agency.gov'] }),
    (error) => error.code === 'SEARCH_INCOMPLETE',
  );

  const contradictoryResult = geminiEvents();
  contradictoryResult[contradictoryResult.length - 1] = {
    type: 'result',
    status: 'success',
    error: { message: 'quota exhausted despite success status' },
  };
  assert.throws(
    () => parseGeminiStream(jsonl(contradictoryResult), { officialDomainAllowlist: ['agency.gov'] }),
    (error) => error.code === 'RATE_LIMIT',
  );
});

test('Codex JSONL은 웹 검색과 최종 답변만 허용한다', () => {
  const envelope = parseCodexStream(jsonl(codexEvents()), {
    officialDomainAllowlist: ['agency.gov'],
  });
  assert.equal(envelope.toolEvidence.byName.WebSearch.official, 1);
  assert.equal(envelope.toolEvidence.byName.WebSearch.broad, 1);
  assert.deepEqual(envelope.groundingUrls, [OFFICIAL_URL, BROAD_URL]);
  assert.equal(envelope.evidenceKind, 'reported');

  const rerouted = codexEvents();
  rerouted.splice(-3, 0, {
    type: 'item.completed',
    item: { id: 'reroute', type: 'error', message: 'Model rerouted to the company fallback model.' },
  });
  const reroutedEnvelope = parseCodexStream(jsonl(rerouted), {
    officialDomainAllowlist: ['agency.gov'],
  });
  assert.deepEqual(reroutedEnvelope.warnings, ['Model rerouted to the company fallback model.']);

  const fatal = codexEvents();
  fatal.splice(-3, 0, {
    type: 'item.completed',
    item: { id: 'quota', type: 'error', message: '429 rate limit exceeded' },
  });
  assert.throws(
    () => parseCodexStream(jsonl(fatal), { officialDomainAllowlist: ['agency.gov'] }),
    (error) => error.code === 'RATE_LIMIT',
  );

  const forbidden = codexEvents();
  forbidden.splice(2, 0, {
    type: 'item.completed',
    item: { id: 'danger', type: 'command_execution', command: 'whoami' },
  });
  assert.throws(
    () => parseCodexStream(jsonl(forbidden), { officialDomainAllowlist: ['agency.gov'] }),
    (error) => error.code === 'SECURITY_POLICY',
  );
});

test('Gemini 가짜 CLI로 버전·보안 인수·stdin·API key 제거를 통합 검증한다', async () => {
  const fake = await installFakeCli('gemini');
  try {
    await withEnvironment({
      GEMINI_CLI_BIN: fake.command,
      GEMINI_API_KEY: 'must-not-leak',
      GOOGLE_API_KEY: 'must-not-leak',
    }, async () => {
      await prepareGeminiResearchWorkspace(fake.workspace);
      const preflight = await preflightGeminiCli({ cwd: fake.workspace, timeoutMs: 10000 });
      assert.equal(preflight.version, '0.53.0');
      const envelope = await callGeminiCli('gemini prompt', {
        cwd: fake.workspace,
        timeoutMs: 10000,
        officialDomainAllowlist: ['agency.gov'],
      });
      assert.equal(envelope.toolEvidence.byName.WebSearch.success, 2);
    });
    const invocations = await readInvocations(fake.invocationFile);
    assert.deepEqual(invocations[0].args, ['--version']);
    assert.deepEqual(invocations[1].args, geminiResearchArguments());
    assert.equal(invocations[1].stdin, 'gemini prompt');
    assert.equal(invocations[1].env.GEMINI_API_KEY, null);
    assert.equal(invocations[1].env.GOOGLE_API_KEY, null);
    assert.equal(path.resolve(invocations[1].cwd), path.resolve(fake.workspace));
  } finally {
    await fs.rm(fake.root, { recursive: true, force: true });
  }
});

test('Codex 가짜 CLI로 로그인·보안 인수·stdin·API key 제거를 통합 검증한다', async () => {
  const fake = await installFakeCli('codex');
  try {
    await withEnvironment({
      CODEX_CLI_BIN: fake.command,
      OPENAI_API_KEY: 'must-not-leak',
      CODEX_API_KEY: 'must-not-leak',
      CODEX_ACCESS_TOKEN: 'must-not-leak',
      OPENAI_BASE_URL: 'https://personal.example.invalid',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://personal.example.invalid/refresh',
      CODEX_REVOKE_TOKEN_URL_OVERRIDE: 'https://personal.example.invalid/revoke',
      CODEX_APP_SERVER_LOGIN_CLIENT_ID: 'personal-client',
      CODEX_AUTHAPI_BASE_URL: 'https://personal.example.invalid/auth',
    }, async () => {
      await prepareCodexResearchWorkspace(fake.workspace);
      const preflight = await preflightCodexCli({ cwd: fake.workspace, timeoutMs: 10000 });
      assert.equal(preflight.version, '0.101.0');
      const envelope = await callCodexCli('codex prompt', {
        cwd: fake.workspace,
        timeoutMs: 10000,
        officialDomainAllowlist: ['agency.gov'],
      });
      assert.equal(envelope.toolEvidence.byName.WebSearch.success, 2);
    });
    const invocations = await readInvocations(fake.invocationFile);
    assert.deepEqual(invocations[0].args, ['--version']);
    assert.deepEqual(invocations[1].args, codexFeatureArguments());
    assert.deepEqual(invocations[2].args, ['login', 'status']);
    assert.deepEqual(invocations[3].args, codexResearchArguments());
    assert.equal(invocations[3].stdin, 'codex prompt');
    assert.equal(invocations[3].env.OPENAI_API_KEY, null);
    assert.equal(invocations[3].env.CODEX_API_KEY, null);
    assert.equal(invocations[3].env.CODEX_ACCESS_TOKEN, null);
    assert.equal(invocations[3].env.OPENAI_BASE_URL, null);
    assert.equal(invocations[1].env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, null);
    assert.equal(invocations[2].env.CODEX_REVOKE_TOKEN_URL_OVERRIDE, null);
    assert.equal(invocations[3].env.CODEX_APP_SERVER_LOGIN_CLIENT_ID, null);
    assert.equal(invocations[3].env.CODEX_AUTHAPI_BASE_URL, null);
    for (const invocation of invocations) {
      for (const name of [
        'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
        'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
        'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
        'CODEX_AUTHAPI_BASE_URL',
      ]) assert.equal(invocation.env[name], null, `${name}이 자식 프로세스에 남았습니다.`);
    }
    assert.equal(path.resolve(invocations[3].cwd), path.resolve(fake.workspace));
  } finally {
    await fs.rm(fake.root, { recursive: true, force: true });
  }
});

test('Codex 사전 점검은 비활성화 실패와 API key 로그인을 실행 전에 거부한다', async () => {
  for (const [mode, expectedCode] of [
    ['codex-feature-enabled', 'CLI_VERSION'],
    ['codex-unreviewed-feature', 'CLI_VERSION'],
    ['codex-api-auth', 'AUTH'],
  ]) {
    const fake = await installFakeCli('codex');
    try {
      await withEnvironment({
        CODEX_CLI_BIN: fake.command,
        TRADE_TEST_FAKE_MODE: mode,
      }, async () => {
        await prepareCodexResearchWorkspace(fake.workspace);
        await assert.rejects(
          preflightCodexCli({ cwd: fake.workspace, timeoutMs: 10000 }),
          (error) => error.code === expectedCode,
        );
      });
    } finally {
      await fs.rm(fake.root, { recursive: true, force: true });
    }
  }
});

test('Codex 전역 AGENTS 지시문은 외부 요청 전에 거부한다', async () => {
  const fake = await installFakeCli('codex');
  const codexHome = path.join(fake.root, 'codex-home');
  await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, 'AGENTS.md'), '외부 요청에 포함하면 안 되는 지시문', 'utf8');
  try {
    await withEnvironment({
      CODEX_CLI_BIN: fake.command,
      CODEX_HOME: codexHome,
    }, async () => {
      await prepareCodexResearchWorkspace(fake.workspace);
      await assert.rejects(
        preflightCodexCli({ cwd: fake.workspace, timeoutMs: 10000 }),
        (error) => error.code === 'SECURITY_POLICY' && /전역 AGENTS/.test(error.message),
      );
    });
    await assert.rejects(fs.access(fake.invocationFile));
  } finally {
    await fs.rm(fake.root, { recursive: true, force: true });
  }
});

test('Gemini와 Codex의 nonzero JSONL 오류도 rate limit으로 정확히 분류한다', async () => {
  for (const provider of ['gemini', 'codex']) {
    const fake = await installFakeCli(provider);
    try {
      await withEnvironment({
        [`${provider === 'gemini' ? 'GEMINI' : 'CODEX'}_CLI_BIN`]: fake.command,
      }, async () => {
        if (provider === 'gemini') {
          await prepareGeminiResearchWorkspace(fake.workspace);
          await withEnvironment({ TRADE_TEST_FAKE_MODE: 'rate-limit' }, async () => {
            await assert.rejects(
              callGeminiCli('prompt', { cwd: fake.workspace, timeoutMs: 10000 }),
              (error) => error.code === 'RATE_LIMIT',
            );
          });
        } else {
          await prepareCodexResearchWorkspace(fake.workspace);
          await preflightCodexCli({ cwd: fake.workspace, timeoutMs: 10000 });
          await withEnvironment({ TRADE_TEST_FAKE_MODE: 'rate-limit' }, async () => {
            await assert.rejects(
              callCodexCli('prompt', { cwd: fake.workspace, timeoutMs: 10000 }),
              (error) => error.code === 'RATE_LIMIT',
            );
          });
        }
      });
    } finally {
      await fs.rm(fake.root, { recursive: true, force: true });
    }
  }
});

test('Codex nonzero item.completed 오류는 인증 오류로 정확히 분류한다', async () => {
  const fake = await installFakeCli('codex');
  try {
    await withEnvironment({
      CODEX_CLI_BIN: fake.command,
    }, async () => {
      await prepareCodexResearchWorkspace(fake.workspace);
      await preflightCodexCli({ cwd: fake.workspace, timeoutMs: 10000 });
      await withEnvironment({ TRADE_TEST_FAKE_MODE: 'auth-error' }, async () => {
        await assert.rejects(
          callCodexCli('prompt', { cwd: fake.workspace, timeoutMs: 10000 }),
          (error) => error.code === 'AUTH',
        );
      });
    });
  } finally {
    await fs.rm(fake.root, { recursive: true, force: true });
  }
});
