import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.dirname(testDir);
const runFile = path.join(cliDir, 'run.mjs');

function fakeClaudeDriver() {
  return `
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');
await fs.appendFile(
  new URL('./invocations.jsonl', import.meta.url),
  JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\\n',
  'utf8',
);

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('2.1.214 (Claude Code)\\n');
  process.exit(0);
}

const specifications = [
  {
    marker: '[조사 영역] 관세',
    domain: 'customs',
    categories: ['북미', '중남미', '인도', '유럽', '중동', '동남아/오세아니아', '아프리카', 'CIS', '동아시아'],
  },
  {
    marker: '[조사 영역] 수출통제',
    domain: 'export',
    categories: ['미국', '한국', 'EU/일본', '중국/베트남', '영국/캐나다/호주/인도', 'UN 및 다자체제'],
  },
  {
    marker: '[조사 영역] 무역구제',
    domain: 'trade',
    categories: ['반덤핑', '세이프가드', '보조금/상계관세'],
  },
];
const specification = specifications.find((candidate) => stdin.includes(candidate.marker));
if (!specification) {
  process.stderr.write('Unknown E2E research prompt');
  process.exit(2);
}

const sessionId = 'e2e-' + specification.domain;
const events = [{
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
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
}];

for (const [index, category] of specification.categories.entries()) {
  const id = 'toolu-' + specification.domain + '-' + index;
  events.push({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'WebSearch',
        input: { query: category + ' 통상 동향' },
      }],
    },
  });
  events.push({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    tool_use_result: {
      query: category + ' 통상 동향',
      results: [{
        tool_use_id: id,
        content: [{
          title: category + ' 공식 검색 결과',
          url: 'https://example.com/' + specification.domain + '/' + index,
        }],
      }],
      durationSeconds: 0.1,
      searchCount: 1,
    },
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        content: '공식 검색 결과 https://example.com/' + specification.domain + '/' + index,
      }],
    },
  });
}

events.push({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify({
    domain: specification.domain,
    insight: '',
    categories: Object.fromEntries(specification.categories.map((category) => [category, []])),
  }),
  session_id: sessionId,
  duration_ms: 10,
  duration_api_ms: 5,
  num_turns: 2,
  total_cost_usd: 0,
  permission_denials: [],
});

for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
`;
}

async function installFakeClaude(rootDirectory) {
  const binDirectory = path.join(rootDirectory, '회사 Claude & CLI');
  await fs.mkdir(binDirectory, { recursive: true });
  const command = path.join(binDirectory, 'claude.cmd');
  const driver = path.join(binDirectory, 'fake-claude.mjs');
  const runtime = path.join(binDirectory, 'node.exe');
  await fs.writeFile(driver, fakeClaudeDriver(), 'utf8');
  try {
    await fs.link(process.execPath, runtime);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EXDEV'].includes(error?.code)) throw error;
    await fs.copyFile(process.execPath, runtime);
  }
  await fs.writeFile(
    command,
    '@echo off\r\n"%~dp0node.exe" "%~dp0fake-claude.mjs" %*\r\n',
    'utf8',
  );
  return {
    command,
    invocationFile: path.join(binDirectory, 'invocations.jsonl'),
  };
}

async function readInvocations(file) {
  const text = await fs.readFile(file, 'utf8');
  return text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test('run.mjs 라이브 경로는 Claude 사전 점검과 세 영역 조사 후 HTML 하나를 저장한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-live-e2e-'));
  try {
    const fake = await installFakeClaude(directory);
    const outputDirectory = path.join(directory, '회사 결과');
    const outputFile = path.join(outputDirectory, 'monitoring.html');
    const env = {
      ...process.env,
      CLAUDE_CLI_BIN: fake.command,
      CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS: '5000',
      CLAUDE_CLI_RETRY_MAX: '1',
      CLAUDE_CLI_TIMEOUT_MS: '5000',
      CLAUDE_RUN_TIMEOUT_MS: '60000',
      CLAUDE_CLI_MODEL: '',
      LOCAL_OUTPUT_FILE: '',
      NO_COLOR: '1',
    };

    const execution = spawnSync(process.execPath, [
      runFile,
      '--out', outputFile,
      '--lookback', '24',
      '--no-open',
    ], {
      cwd: cliDir,
      env,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });

    assert.equal(execution.error, undefined, execution.error?.message);
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    assert.equal(execution.signal, null);
    assert.match(execution.stdout, /Claude Code 2\.1\.214 확인 완료/);
    assert.match(execution.stdout, /\[1\/3\] 관세 조사 시작/);
    assert.match(execution.stdout, /\[2\/3\] 수출통제 조사 시작/);
    assert.match(execution.stdout, /\[3\/3\] 무역구제 조사 시작/);
    assert.match(execution.stdout, /HTML 저장 완료/);
    assert.match(execution.stdout, /메일 발송, 예약 실행, 외부 저장은 수행하지 않았습니다/);
    assert.equal(execution.stderr, '');

    const invocations = await readInvocations(fake.invocationFile);
    assert.equal(invocations.length, 4);
    assert.deepEqual(invocations[0].args, ['--version']);
    assert.equal(invocations[0].stdin, '');
    const researchInvocations = invocations.slice(1);
    const expectedResearch = [
      {
        label: '관세',
        categories: ['북미', '중남미', '인도', '유럽', '중동', '동남아/오세아니아', '아프리카', 'CIS', '동아시아'],
      },
      {
        label: '수출통제',
        categories: ['미국', '한국', 'EU/일본', '중국/베트남', '영국/캐나다/호주/인도', 'UN 및 다자체제'],
      },
      {
        label: '무역구제',
        categories: ['반덤핑', '세이프가드', '보조금/상계관세'],
      },
    ];
    assert.deepEqual(
      researchInvocations.map((invocation) => (
        expectedResearch.map(({ label }) => label).find((label) => (
          invocation.stdin.includes(`[조사 영역] ${label}`)
        ))
      )),
      ['관세', '수출통제', '무역구제'],
    );
    for (const [index, invocation] of researchInvocations.entries()) {
      assert.ok(invocation.args.includes('--safe-mode'));
      assert.ok(invocation.args.includes('WebSearch'));
      assert.ok(invocation.args.includes('stream-json'));
      assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
      assert.equal(invocation.args.includes('--add-dir'), false);
      for (const category of expectedResearch[index].categories) {
        assert.ok(invocation.stdin.includes(`"${category}": [`));
      }
    }
    assert.equal(new Set(invocations.map((invocation) => path.resolve(invocation.cwd))).size, 1);
    const isolatedWorkspace = invocations[0].cwd;
    assert.match(path.basename(isolatedWorkspace), /^trade-monitor-claude-/);
    await assert.rejects(() => fs.access(isolatedWorkspace), (error) => error.code === 'ENOENT');

    const html = await fs.readFile(outputFile, 'utf8');
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /결과 생성 완료/);
    assert.match(html, /세 영역의 Claude Code 조사 결과/);
    assert.match(html, /카테고리 9\/9/);
    assert.match(html, /웹 검색 9회 성공/);
    assert.match(html, /카테고리 6\/6/);
    assert.match(html, /웹 검색 6회 성공/);
    assert.match(html, /카테고리 3\/3/);
    assert.match(html, /웹 검색 3회 성공/);
    assert.doesNotMatch(html, /테스트 데이터/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /<img\b/i);
    assert.match(html, /<\/html>\s*$/i);
    assert.deepEqual(await fs.readdir(outputDirectory), ['monitoring.html']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
