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
const repoRoot = path.dirname(cliDir);
const runFile = path.join(cliDir, 'run.mjs');
const wrapperFile = path.join(repoRoot, 'run-monitoring.cmd');
const fixture = path.join(testDir, 'fixtures', 'responses.json');

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
if (args.length === 2 && args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('{"authMethod":"enterprise-oauth"}\\n');
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
const selectedCategories = specification.categories.filter((category) => (
  stdin.includes('"' + category + '": [')
));
if (selectedCategories.length !== 1) {
  process.stderr.write('Expected exactly one category in E2E research prompt');
  process.exit(2);
}
const category = selectedCategories[0];
const categoryIndex = specification.categories.indexOf(category);
const coveragePrefix = '[반드시 검색 query로 모두 확인할 하위 대상] ';
const coverageLine = stdin.split(String.fromCharCode(10))
  .find((line) => line.startsWith(coveragePrefix)) || '';
const coverageTargets = coverageLine.slice(coveragePrefix.length)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const officialDomainMatch = stdin.match(/신뢰 목록의 hostname 또는 그 하위 도메인만 1개 이상 넣는다: ([^\\r\\n]+)/);
if (!officialDomainMatch) {
  process.stderr.write('Expected trusted official-domain list in E2E research prompt');
  process.exit(2);
}
const officialDomain = officialDomainMatch[1].split(',')[0].trim();
const officialCount = Number((stdin.match(/공식기관 원문 검색은.*?최소 ([0-9]+)회/) || [])[1] || 3);
const broadCount = Number((stdin.match(/일반 동향 검색은.*?최소 ([0-9]+)회/) || [])[1] || 3);
const officialTargetLimit = Number((stdin.match(/공식 query 하나에는 하위 대상을 최대 ([0-9]+)개/) || [])[1] || 2);

const sessionId = 'e2e-' + specification.domain + '-' + categoryIndex;
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

const searchPerspectives = [
  'official law gazette',
  'official implementation guidance',
  'official electronics product HS measure',
  'major media policy news',
  'local language industry news',
  'Korean company supply chain impact',
  'tariff schedule legal database review',
  'regulatory enforcement licensing update',
  'parliamentary trade policy announcement',
  'sector product compliance bulletin',
];
const officialTargetBuckets = Array.from({ length: officialCount }, () => []);
const broadTargetBuckets = Array.from({ length: broadCount }, () => []);
for (const [index, target] of coverageTargets.entries()) {
  officialTargetBuckets[index % officialTargetBuckets.length].push(target);
  broadTargetBuckets[index % broadTargetBuckets.length].push(target);
}
if (officialTargetBuckets.some((bucket) => bucket.length > officialTargetLimit)) {
  process.stderr.write('E2E official target distribution exceeds prompt limit');
  process.exit(2);
}
const searches = Array.from({ length: officialCount + broadCount }, (_, index) => {
  const official = index < officialCount;
  const targetBucket = official
    ? officialTargetBuckets[index]
    : broadTargetBuckets[index - officialCount];
  return {
    id: 'toolu-' + specification.domain + '-' + categoryIndex + '-'
      + (official ? 'official-' : 'broad-') + (index + 1),
    // 복합 카테고리명 자체를 넣으면 한 query가 모든 하위 대상으로 오인된다.
    // 실제 프롬프트 정책처럼 대상 이름만 제한 개수로 분산한다.
    query: [searchPerspectives[index], ...targetBucket].filter(Boolean).join(' '),
    ...(official ? { allowed_domains: [officialDomain] } : {}),
  };
});
for (const search of searches) {
  events.push({
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: search.id,
        name: 'WebSearch',
        input: {
          query: search.query,
          ...(search.allowed_domains ? { allowed_domains: search.allowed_domains } : {}),
        },
      }],
    },
  });
  events.push({
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    tool_use_result: {
      query: search.query,
      results: [{
        tool_use_id: search.id,
        content: [{
          title: category + ' 공식 검색 결과',
          url: (search.allowed_domains
            ? 'https://' + officialDomain
            : 'https://example.com') + '/' + specification.domain + '/' + categoryIndex,
        }],
      }],
      durationSeconds: 0.1,
      searchCount: 1,
    },
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: search.id,
        content: '검색 결과 https://example.com/' + specification.domain + '/' + categoryIndex,
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
    categories: { [category]: [] },
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
  await fs.writeFile(driver, fakeClaudeDriver(), 'utf8');
  const batchNodePath = process.execPath.replace(/%/g, '%%');
  await fs.writeFile(
    command,
    `@echo off\r\n"${batchNodePath}" "%~dp0fake-claude.mjs" %*\r\n`,
    'utf8',
  );
  return {
    binDirectory,
    command,
    invocationFile: path.join(binDirectory, 'invocations.jsonl'),
  };
}

async function readInvocations(file) {
  const text = await fs.readFile(file, 'utf8');
  return text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

async function removeTestDirectory(directory) {
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}

test('--version은 AI CLI 사전 점검 없이 앱 버전을 출력한다', () => {
  const execution = spawnSync(process.execPath, [runFile, '--version'], {
    cwd: cliDir,
    env: { ...process.env, CLAUDE_CLI_BIN: 'definitely-missing-claude' },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stdout, /trade-monitor-cli 7\.1\.0/);
  assert.equal(execution.stderr, '');
});

test('Windows 네트워크 TEMP에서는 Claude 실행 전에 보안 오류로 중단한다', {
  skip: process.platform !== 'win32',
}, () => {
  const execution = spawnSync(process.execPath, [
    runFile,
    '--category', 'customs:북미',
    '--no-open',
  ], {
    cwd: cliDir,
    env: {
      ...process.env,
      TEMP: '\\\\server\\share\\temp',
      TMP: '\\\\server\\share\\temp',
      CLAUDE_CLI_BIN: 'definitely-missing-claude',
    },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(execution.status, 1, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /OS 임시 폴더가 로컬 일반 절대경로가 아니/);
  assert.match(execution.stderr, /오류 코드: SECURITY_POLICY/);
});

test('--help는 초보 사용자의 wrapper 명령과 모든 실행 안전 옵션을 표시한다', () => {
  const execution = spawnSync(process.execPath, [runFile, '--help'], {
    cwd: cliDir,
    env: { ...process.env, CLAUDE_CLI_BIN: 'definitely-missing-claude' },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stdout, /\.\\run-monitoring\.cmd --version/);
  assert.match(execution.stdout, /--allow-partial-overwrite/);
  assert.match(execution.stdout, /--allow-parallel/);
  assert.match(execution.stdout, /--allow-network-output/);
  assert.doesNotMatch(execution.stdout, /node \.\\cli\\run\.mjs/);
  assert.equal(execution.stderr, '');
});

test('Windows wrapper의 부분 결과 문구는 대표 파일 보존 여부를 단정하지 않는다', async () => {
  const wrapper = await fs.readFile(wrapperFile, 'utf8');
  assert.match(wrapper, /Monitoring completed with partial results\. Review the saved HTML path shown above\./);
  assert.doesNotMatch(wrapper, /previous complete report was preserved/i);
});

test('--list-categories는 Claude 사전 점검 없이 복사 가능한 18개 ID를 출력한다', () => {
  const execution = spawnSync(process.execPath, [runFile, '--list-categories'], {
    cwd: cliDir,
    env: { ...process.env, CLAUDE_CLI_BIN: 'definitely-missing-claude' },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(execution.error, undefined, execution.error?.message);
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  const ids = execution.stdout.match(/^  (?:customs|export|trade):.+?(?=  \()/gm) || [];
  assert.equal(ids.length, 18);
  assert.match(execution.stdout, /customs:북미/);
  assert.match(execution.stdout, /export:UN 및 다자체제/);
  assert.match(execution.stdout, /trade:보조금\/상계관세/);
  assert.doesNotMatch(execution.stdout, /Claude Code .*확인/);
});

test('--list-groups는 Claude 사전 점검 없이 영문·한글 그룹 이름을 출력한다', () => {
  const execution = spawnSync(process.execPath, [runFile, '--list-groups'], {
    cwd: cliDir,
    env: { ...process.env, CLAUDE_CLI_BIN: 'definitely-missing-claude' },
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  assert.equal(execution.error, undefined, execution.error?.message);
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stdout, /customs 또는 관세  \(9개 카테고리\)/);
  assert.match(execution.stdout, /export 또는 수출통제  \(6개 카테고리\)/);
  assert.match(execution.stdout, /trade 또는 무역구제  \(3개 카테고리\)/);
  assert.doesNotMatch(execution.stdout, /Claude Code .*확인/);
});

test('run.mjs 라이브 경로는 사전 점검과 18개 카테고리별 6회 심층 검색 후 HTML 하나를 저장한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-live-e2e-'));
  try {
    const fake = await installFakeClaude(directory);
    await assert.rejects(
      fs.access(path.join(fake.binDirectory, 'node.exe')),
      (error) => error?.code === 'ENOENT',
    );
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
    assert.match(execution.stdout, /Claude Code CLI 2\.1\.214 확인 완료/);
    assert.match(execution.stdout, /\[1\/18\] 관세 \/ 북미 조사 시작/);
    assert.match(execution.stdout, /\[18\/18\] 관세 \/ 동아시아 조사 시작/);
    assert.match(execution.stdout, /HTML 저장 완료/);
    assert.match(execution.stdout, /메일 발송, 예약 실행, 외부 서비스 저장은 수행하지 않았습니다/);
    assert.match(
      execution.stderr,
      /^(?:실행 환경 주의: Claude CLI에 인증·라우팅 관련 환경변수가 상속됩니다\. 진단에는 이름만 표시하며 값은 표시하지 않습니다\.\r?\n)?$/,
    );

    const invocations = await readInvocations(fake.invocationFile);
    assert.equal(invocations.length, 20);
    assert.deepEqual(invocations[0].args, ['--version']);
    assert.equal(invocations[0].stdin, '');
    assert.deepEqual(invocations[1].args, ['auth', 'status']);
    const researchInvocations = invocations.slice(2);
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
    const maximumCategoryCount = Math.max(
      ...expectedResearch.map(({ categories }) => categories.length),
    );
    const expectedTargets = Array.from({ length: maximumCategoryCount }, (_, categoryIndex) => (
      expectedResearch.flatMap(({ label, categories }) => (
        categories[categoryIndex] ? [{ label, category: categories[categoryIndex] }] : []
      ))
    )).flat();
    assert.equal(researchInvocations.length, expectedTargets.length);
    for (const [index, invocation] of researchInvocations.entries()) {
      const target = expectedTargets[index];
      assert.ok(invocation.args.includes('--safe-mode'));
      assert.ok(invocation.args.includes('WebSearch'));
      assert.ok(invocation.args.includes('stream-json'));
      assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
      assert.equal(invocation.args.includes('--add-dir'), false);
      assert.ok(invocation.stdin.includes(`[조사 영역] ${target.label}`));
      assert.ok(invocation.stdin.includes(`"${target.category}": [`));
      const allCategories = expectedResearch.flatMap((entry) => entry.categories);
      for (const category of allCategories.filter((candidate) => candidate !== target.category)) {
        assert.equal(invocation.stdin.includes(`"${category}": [`), false);
      }
    }
    assert.equal(new Set(invocations.map((invocation) => path.resolve(invocation.cwd))).size, 1);
    const isolatedWorkspace = invocations[0].cwd;
    assert.match(path.basename(isolatedWorkspace), /^trade-monitor-claude-/);
    await assert.rejects(() => fs.access(isolatedWorkspace), (error) => error.code === 'ENOENT');

    const html = await fs.readFile(outputFile, 'utf8');
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /결과 생성 완료/);
    assert.match(html, /요청한 18개 카테고리의 Claude Code CLI 표준 조사를 정리했습니다/);
    assert.match(html, /카테고리 9\/9/);
    assert.match(html, /웹 검색 60회 성공/);
    assert.match(html, /카테고리 6\/6/);
    assert.match(html, /웹 검색 36회 성공/);
    assert.match(html, /카테고리 3\/3/);
    assert.match(html, /웹 검색 18회 성공/);
    assert.doesNotMatch(html, /테스트 데이터/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<link\b/i);
    assert.doesNotMatch(html, /<img\b/i);
    assert.match(html, /<\/html>\s*$/i);
    assert.deepEqual(await fs.readdir(outputDirectory), ['monitoring.html']);
  } finally {
    await removeTestDirectory(directory);
  }
});

test('run.mjs 단일 카테고리 모드는 선택 범위만 한 번 조사해 별도 HTML을 만든다', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-live-single-'));
  try {
    const fake = await installFakeClaude(directory);
    const outputFile = path.join(directory, 'single-category.html');
    const execution = spawnSync(process.execPath, [
      runFile,
      '--category', 'customs:북미',
      '--out', outputFile,
      '--lookback', '24',
      '--no-open',
    ], {
      cwd: cliDir,
      env: {
        ...process.env,
        CLAUDE_CLI_BIN: fake.command,
        CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS: '5000',
        CLAUDE_CLI_RETRY_MAX: '1',
        CLAUDE_CLI_TIMEOUT_MS: '5000',
        CLAUDE_RUN_TIMEOUT_MS: '60000',
        CLAUDE_CLI_MODEL: '',
        LOCAL_OUTPUT_FILE: '',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });

    assert.equal(execution.error, undefined, execution.error?.message);
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    assert.match(execution.stdout, /\[1\/1\] 관세 \/ 북미 조사 시작/);
    const invocations = await readInvocations(fake.invocationFile);
    assert.equal(invocations.length, 3);
    assert.deepEqual(invocations[0].args, ['--version']);
    assert.deepEqual(invocations[1].args, ['auth', 'status']);
    assert.match(invocations[2].stdin, /"북미": \[/);
    assert.doesNotMatch(invocations[2].stdin, /"중남미": \[/);

    const html = await fs.readFile(outputFile, 'utf8');
    assert.match(html, /선택 조사 · 관세 \/ 북미/);
    assert.match(html, /요청한 1개 카테고리의 Claude Code CLI 표준 조사를 정리했습니다/);
    assert.match(html, /카테고리 1\/1 · 웹 검색 6회 성공/);
    assert.match(html, />북미</);
    assert.doesNotMatch(html, />중남미</);
    assert.doesNotMatch(html, />수출통제</);
    assert.doesNotMatch(html, />무역구제</);
  } finally {
    await removeTestDirectory(directory);
  }
});

test('run.mjs 그룹 모드는 선택한 영역의 카테고리만 각각 조사해 HTML 하나를 만든다', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-live-group-'));
  try {
    const fake = await installFakeClaude(directory);
    const outputFile = path.join(directory, 'monitoring-trade.html');
    const execution = spawnSync(process.execPath, [
      runFile,
      '--group', '무역구제',
      '--out', outputFile,
      '--lookback', '24',
      '--no-open',
    ], {
      cwd: cliDir,
      env: {
        ...process.env,
        CLAUDE_CLI_BIN: fake.command,
        CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS: '5000',
        CLAUDE_CLI_RETRY_MAX: '1',
        CLAUDE_CLI_TIMEOUT_MS: '5000',
        CLAUDE_RUN_TIMEOUT_MS: '60000',
        CLAUDE_CLI_MODEL: '',
        LOCAL_OUTPUT_FILE: '',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });

    assert.equal(execution.error, undefined, execution.error?.message);
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    assert.match(execution.stdout, /\[1\/3\] 무역구제 \/ 반덤핑 조사 시작/);
    assert.match(execution.stdout, /\[3\/3\] 무역구제 \/ 보조금\/상계관세 조사 시작/);
    const invocations = await readInvocations(fake.invocationFile);
    assert.equal(invocations.length, 5);
    assert.deepEqual(invocations[0].args, ['--version']);
    assert.deepEqual(invocations[1].args, ['auth', 'status']);
    const expectedCategories = ['반덤핑', '세이프가드', '보조금/상계관세'];
    for (const [index, invocation] of invocations.slice(2).entries()) {
      assert.match(invocation.stdin, /\[조사 영역\] 무역구제/);
      assert.ok(invocation.stdin.includes(`"${expectedCategories[index]}": [`));
      for (const other of expectedCategories.filter((value) => value !== expectedCategories[index])) {
        assert.equal(invocation.stdin.includes(`"${other}": [`), false);
      }
    }

    const html = await fs.readFile(outputFile, 'utf8');
    assert.match(html, /선택 그룹 · 무역구제 · 3개 카테고리/);
    assert.match(html, /요청한 3개 카테고리의 Claude Code CLI 표준 조사를 정리했습니다/);
    assert.match(html, /카테고리 3\/3 · 웹 검색 18회 성공/);
    assert.match(html, /id="domain-trade"/);
    assert.doesNotMatch(html, /id="domain-customs"|id="domain-export"/);
    assert.doesNotMatch(html, /undefined/);
  } finally {
    await removeTestDirectory(directory);
  }
});

test('부분 결과는 기본 별도 저장하고 명시적 대표 파일 교체 시 정확한 문구와 종료 코드 2를 사용한다', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-partial-message-'));
  try {
    const mock = JSON.parse(await fs.readFile(fixture, 'utf8'));
    mock.domains.trade = {
      __error: { code: 'MOCK_ERROR', message: '부분 결과 안내 테스트 실패' },
    };
    const mockFile = path.join(directory, 'partial.json');
    const outputFile = path.join(directory, 'monitoring.html');
    const originalHtml = '<!DOCTYPE html><html><body>기존 대표 결과</body></html>';
    await fs.writeFile(mockFile, JSON.stringify(mock), 'utf8');
    await fs.writeFile(outputFile, originalHtml, 'utf8');
    const common = [
      runFile,
      '--mock', mockFile,
      '--out', outputFile,
      '--lookback', '24',
      '--no-open',
    ];
    const spawnOptions = {
      cwd: cliDir,
      env: { ...process.env, LOCAL_OUTPUT_FILE: '', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    };

    const preserved = spawnSync(process.execPath, common, spawnOptions);
    assert.equal(preserved.status, 2, `${preserved.stdout}\n${preserved.stderr}`);
    assert.match(preserved.stdout, /부분 HTML 별도 저장 완료:/);
    assert.doesNotMatch(preserved.stdout, /부분 HTML 대표 파일 저장 완료:/);
    assert.match(preserved.stderr, /기존 대표 결과는 보존했습니다:/);
    assert.equal(await fs.readFile(outputFile, 'utf8'), originalHtml);
    const partialFiles = (await fs.readdir(directory))
      .filter((name) => /^monitoring\.partial-\d{8}T\d{9}Z\.html$/.test(name));
    assert.equal(partialFiles.length, 1);

    const overwritten = spawnSync(
      process.execPath,
      [...common, '--allow-partial-overwrite'],
      spawnOptions,
    );
    assert.equal(overwritten.status, 2, `${overwritten.stdout}\n${overwritten.stderr}`);
    assert.match(overwritten.stdout, /부분 HTML 대표 파일 저장 완료:/);
    assert.doesNotMatch(overwritten.stdout, /부분 HTML 별도 저장 완료:/);
    assert.match(overwritten.stderr, /대표 결과를 부분 결과로 교체했습니다:/);
    assert.doesNotMatch(overwritten.stderr, /기존 대표 결과는 보존했습니다:/);
    const replacedHtml = await fs.readFile(outputFile, 'utf8');
    assert.match(replacedHtml, /^<!DOCTYPE html>/);
    assert.match(replacedHtml, /일부 범위 조사 실패/);
  } finally {
    await removeTestDirectory(directory);
  }
});
