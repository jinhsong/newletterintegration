import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  callGeminiCli,
  extractToolEvidence,
  prepareResearchWorkspace,
  preflightGeminiCli,
  retryMax,
  stopAllGeminiProcesses,
  totalTimeoutMs,
} from '../src/gemini-client.mjs';

async function withFakeGemini(script, worker, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-gemini-cli-'));
  const binDirectory = options.binSubdirectory
    ? path.join(directory, options.binSubdirectory)
    : directory;
  await fs.mkdir(binDirectory, { recursive: true });
  const command = path.join(binDirectory, 'fake-gemini.cmd');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'Path';
  const originalPath = process.env[pathKey];
  const originalBin = process.env.GEMINI_CLI_BIN;
  try {
    await fs.writeFile(command, script, 'utf8');
    await prepareResearchWorkspace(directory);
    process.env[pathKey] = `${binDirectory};${originalPath || ''}`;
    process.env.GEMINI_CLI_BIN = options.absoluteBin ? command : 'fake-gemini';
    return await worker(directory, command);
  } finally {
    await stopAllGeminiProcesses();
    process.env[pathKey] = originalPath;
    if (originalBin === undefined) delete process.env.GEMINI_CLI_BIN;
    else process.env.GEMINI_CLI_BIN = originalBin;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const SEARCH_STATS = '{"tools":{"totalCalls":1,"totalSuccess":1,"totalFail":0,"byName":{"google_web_search":{"count":1,"success":1,"fail":0}}}}';

test('격리 작업 설정은 Google 웹 검색만 등록하고 hooks·skills를 끈다', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'research-workspace-settings-'));
  try {
    const settingsFile = await prepareResearchWorkspace(directory);
    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    assert.deepEqual(settings.tools.core, ['google_web_search']);
    assert.equal(settings.tools.discoveryCommand, '');
    assert.equal(settings.hooksConfig.enabled, false);
    assert.equal(settings.skills.enabled, false);
    assert.deepEqual(settings.mcp.allowed, ['__newsletter_runner_no_mcp__']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('도구 통계를 상위 파이프라인용 증거로 정규화한다', () => {
  assert.deepEqual(extractToolEvidence({
    tools: {
      totalCalls: 2,
      totalSuccess: 1,
      totalFail: 1,
      byName: {
        google_web_search: { count: 2, success: 1, fail: 1, durationMs: 30 },
      },
    },
  }), {
    available: true,
    totalCalls: 2,
    totalSuccess: 1,
    totalFail: 1,
    byName: {
      google_web_search: { count: 2, success: 1, fail: 1 },
    },
  });
  assert.deepEqual(extractToolEvidence(null), {
    available: false,
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    byName: {},
  });
});

test('재시도 환경변수는 숫자 전체가 올바를 때만 허용한다', () => {
  const original = process.env.GEMINI_CLI_RETRY_MAX;
  try {
    process.env.GEMINI_CLI_RETRY_MAX = '3abc';
    assert.equal(retryMax(), 2);
    process.env.GEMINI_CLI_RETRY_MAX = '3';
    assert.equal(retryMax(), 3);
  } finally {
    if (original === undefined) delete process.env.GEMINI_CLI_RETRY_MAX;
    else process.env.GEMINI_CLI_RETRY_MAX = original;
  }
});

test('전체 실행 제한은 기본 45분이며 안전한 정수 환경변수만 반영한다', () => {
  const original = process.env.GEMINI_RUN_TIMEOUT_MS;
  try {
    delete process.env.GEMINI_RUN_TIMEOUT_MS;
    assert.equal(totalTimeoutMs(), 2700000);
    process.env.GEMINI_RUN_TIMEOUT_MS = '3600000';
    assert.equal(totalTimeoutMs(), 3600000);
    process.env.GEMINI_RUN_TIMEOUT_MS = '10minutes';
    assert.equal(totalTimeoutMs(), 2700000);
  } finally {
    if (original === undefined) delete process.env.GEMINI_RUN_TIMEOUT_MS;
    else process.env.GEMINI_RUN_TIMEOUT_MS = original;
  }
});

test('Windows headless Gemini JSON 응답과 warnings 및 검색 증거를 보존한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const envelope = `{"session_id":"session-1","response":"ok","warnings":["주의"],"stats":${SEARCH_STATS}}`;
  await withFakeGemini(`@echo off\r\necho ${envelope}\r\n`, async (directory) => {
    const result = await callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, 'ok');
    assert.equal(result.sessionId, 'session-1');
    assert.deepEqual(result.warnings, ['주의']);
    assert.equal(result.toolEvidence.byName.google_web_search.success, 1);
  });
});

test('Windows에서 없는 Gemini 명령은 로캘과 무관하게 CLI_NOT_FOUND로 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'missing-gemini-cli-'));
  const originalBin = process.env.GEMINI_CLI_BIN;
  try {
    await prepareResearchWorkspace(directory);
    process.env.GEMINI_CLI_BIN = 'definitely-missing-gemini-cli-command';
    await assert.rejects(
      () => preflightGeminiCli({ cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'CLI_NOT_FOUND' && /PATH/.test(error.message),
    );
  } finally {
    if (originalBin === undefined) delete process.env.GEMINI_CLI_BIN;
    else process.env.GEMINI_CLI_BIN = originalBin;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Windows 실행은 검색 외 도구 호출이 관측되면 결과를 폐기한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const stats = '{"tools":{"totalCalls":1,"totalSuccess":1,"totalFail":0,"byName":{"read_file":{"success":1,"fail":0}}}}';
  await withFakeGemini(`@echo off\r\necho {"response":"unsafe","stats":${stats}}\r\n`, async (directory) => {
    await assert.rejects(
      () => callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'SECURITY_POLICY' && /read_file/.test(error.details),
    );
  });
});

test('Windows Gemini 실행에는 검색 전용 정책과 확장/MCP 차단 옵션을 강제한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const script = [
    '@echo off',
    'echo %* > "%~dp0\\args.txt"',
    'echo {"response":"ok"}',
    '',
  ].join('\r\n');
  await withFakeGemini(script, async (directory, command) => {
    await callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 });
    const args = await fs.readFile(path.join(path.dirname(command), 'args.txt'), 'utf8');
    assert.match(args, /"--prompt"\s+"Follow the complete task provided on standard input/);
    assert.match(args, /"--output-format"\s+"json"/);
    assert.match(args, /"--policy"\s+/);
    assert.match(args, /research-only\.toml/);
    assert.match(args, /"--extensions"\s+"none"/);
    assert.match(args, /"--allowed-mcp-server-names"\s+"__newsletter_runner_no_mcp__"/);
    assert.match(args, /"--approval-mode"\s+"default"/);
    assert.match(args, /"--skip-trust"/);
  });
});

test('Windows 사용자 지정 CLI 경로는 공백·한글·메타문자를 안전하게 전달한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini('@echo off\r\necho {"response":"ok"}\r\n', async (directory) => {
    const result = await callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, 'ok');
  }, {
    absoluteBin: true,
    binSubdirectory: '회사 Gemini & CLI',
  });
});

test('Gemini 자식 환경에는 임의 비밀값과 개인 API 키를 전달하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const originalSecret = process.env.NEWSLETTER_TEST_SECRET;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  process.env.NEWSLETTER_TEST_SECRET = 'must-not-leak';
  process.env.GEMINI_API_KEY = 'personal-gemini-key';
  process.env.GOOGLE_API_KEY = 'personal-google-key';
  try {
    const script = '@echo off\r\necho {"response":"%NEWSLETTER_TEST_SECRET%:%GEMINI_API_KEY%:%GOOGLE_API_KEY%"}\r\n';
    await withFakeGemini(script, async (directory) => {
      const result = await callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 });
      assert.equal(result.response, '::');
    });
  } finally {
    if (originalSecret === undefined) delete process.env.NEWSLETTER_TEST_SECRET;
    else process.env.NEWSLETTER_TEST_SECRET = originalSecret;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleKey;
  }
});

test('응답 내부 ENOENT 문자열을 CLI 미설치로 오분류하지 않는다', {
  skip: process.platform !== 'win32',
}, async () => {
  const script = '@echo off\r\necho {"error":{"message":"Internal ENOENT while reading cache"}}\r\n';
  await withFakeGemini(script, async (directory) => {
    await assert.rejects(
      () => callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'CLI_EXIT',
    );
  });
});

test('종료 코드가 실패여도 stdout의 구조화 오류와 stderr를 함께 분류한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const script = [
    '@echo off',
    'echo {"error":{"message":"Authentication required; please sign in"}}',
    'echo harmless diagnostic 1>&2',
    'exit /b 1',
    '',
  ].join('\r\n');
  await withFakeGemini(script, async (directory) => {
    await assert.rejects(
      () => callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'AUTH' && /harmless diagnostic/.test(error.details),
    );
  });
});

test('사전 점검은 보안 실행에 필요한 최신 CLI 옵션을 확인한다', {
  skip: process.platform !== 'win32',
}, async () => {
  const help = '--prompt --output-format --policy --extensions --allowed-mcp-server-names --approval-mode --skip-trust';
  await withFakeGemini(`@echo off\r\necho ${help}\r\n`, async (directory) => {
    const result = await preflightGeminiCli({ cwd: directory, timeoutMs: 5000 });
    assert.ok(result.supportedFlags.includes('--policy'));
    assert.match(result.policyPath, /research-only\.toml$/);
  });
});

test('사전 점검은 정책 옵션이 없는 구버전 CLI를 명확히 거부한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini('@echo off\r\necho --output-format --extensions\r\n', async (directory) => {
    await assert.rejects(
      () => preflightGeminiCli({ cwd: directory, timeoutMs: 5000 }),
      (error) => error.code === 'CLI_VERSION' && /--policy/.test(error.details),
    );
  });
});

test('Windows 시간 초과 시 프로세스 트리를 종료한 뒤 TIMEOUT을 반환한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini([
    '@echo off',
    'ping 127.0.0.1 -n 20 >nul',
    'echo {"response":"late"}',
    '',
  ].join('\r\n'), async (directory) => {
    const startedAt = Date.now();
    await assert.rejects(
      () => callGeminiCli('시험', { cwd: directory, timeoutMs: 100 }),
      (error) => error.code === 'TIMEOUT',
    );
    assert.ok(Date.now() - startedAt < 8000);
  });
});

test('중단 신호는 Gemini 프로세스를 정리한 뒤 ABORTED를 반환한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini([
    '@echo off',
    'ping 127.0.0.1 -n 20 >nul',
    'echo {"response":"late"}',
    '',
  ].join('\r\n'), async (directory) => {
    const controller = new AbortController();
    const call = callGeminiCli('시험', {
      cwd: directory,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(call, (error) => error.code === 'ABORTED');
  });
});

test('활성 Gemini 호출 중 전체 제한 신호가 오면 RUN_TIMEOUT 원인을 보존한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini([
    '@echo off',
    'ping 127.0.0.1 -n 20 >nul',
    'echo {"response":"late"}',
    '',
  ].join('\r\n'), async (directory) => {
    const controller = new AbortController();
    const call = callGeminiCli('시험', {
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
