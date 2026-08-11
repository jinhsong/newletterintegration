import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli-args.mjs';
import {
  isNetworkOutputPath,
  partialOutputFileFor,
  recoverInterruptedOutput,
  recoveryFileFor,
  recoveryManifestFor,
  resolveMonitoringOutputFile,
  saveHtmlOutput,
} from '../src/output-store.mjs';
import {
  acquireRunLock,
  lockPathFor,
} from '../src/run-lock.mjs';
import { loadEnvFile, validateRuntimeEnvironment } from '../src/runtime-config.mjs';
import {
  automaticFromDate,
  lastCompleteRun,
  monitoringScopeKey,
  recordCompleteRun,
} from '../src/run-state.mjs';

async function withTempDir(worker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-runtime-'));
  try {
    return await worker(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writeRecoveryPair(output, html) {
  await fs.writeFile(recoveryFileFor(output), html, 'utf8');
  await fs.writeFile(recoveryManifestFor(output), JSON.stringify({
    app: 'trade-monitor-claude-cli',
    version: 1,
    outputFile: path.resolve(output),
    token: '00000000-0000-4000-8000-000000000001',
  }), 'utf8');
}

test('CLI 인자는 provider·임의 lookback·그룹·단일 카테고리·값이 있는 경로만 받는다', () => {
  const cwd = path.resolve('example-root');
  const parsed = parseArgs([
    '--lookback', '72',
    '--provider', 'GEMINI',
    '--category', 'customs:북미',
    '--depth', 'deep',
    '--out', 'result.html',
    '--allow-partial-overwrite',
    '--allow-parallel',
    '--allow-network-output',
    '--open',
  ], cwd);
  assert.equal(parsed.lookbackHours, 72);
  assert.equal(parsed.provider, 'gemini');
  assert.equal(parsed.category, 'customs:북미');
  assert.equal(parsed.depth, 'deep');
  assert.equal(parsed.allowPartialOverwrite, true);
  assert.equal(parsed.allowParallel, true);
  assert.equal(parsed.allowNetworkOutput, true);
  assert.equal(parsed.outputFile, path.resolve(cwd, 'result.html'));
  assert.equal(parsed.open, true);

  assert.equal(parseArgs(['--category', 'UN 및 다자체제'], cwd).category, 'UN 및 다자체제');
  assert.equal(parseArgs(['--group', '관세'], cwd).group, '관세');
  assert.equal(parseArgs([], cwd).depth, 'standard');
  assert.equal(parseArgs(['--lookback', '1'], cwd).lookbackHours, 1);
  assert.equal(parseArgs(['--lookback', '48'], cwd).lookbackHours, 48);
  assert.equal(parseArgs(['--lookback', '168'], cwd).lookbackHours, 168);
  assert.equal(parseArgs(['--provider', 'chatgpt'], cwd).provider, 'chatgpt');
  assert.equal(parseArgs(['--list-categories', '--open'], cwd).listCategories, true);
  assert.equal(parseArgs(['--list-groups', '--open'], cwd).listGroups, true);
  assert.throws(() => parseArgs(['--lookback', 'abc'], cwd), /1~168/);
  for (const invalid of ['0', '169', '1.5', '-1', '+1', '1e2']) {
    assert.throws(() => parseArgs(['--lookback', invalid], cwd), /1~168/);
  }
  assert.throws(() => parseArgs(['--lookback'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--lookback', '24', '--lookback', '48'], cwd), /한 번만/);
  assert.throws(() => parseArgs(['--provider'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--provider', 'openai'], cwd), /claude, gemini, chatgpt/);
  assert.throws(() => parseArgs(['--provider', 'claude', '--provider', 'gemini'], cwd), /한 번만/);
  assert.throws(() => parseArgs(['--depth', 'maximum'], cwd), /fast, standard, deep/);
  assert.throws(() => parseArgs(['--depth', 'fast', '--depth', 'deep'], cwd), /한 번만/);
  assert.throws(() => parseArgs(['--category'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--category', '   '], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--group'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--group', '   '], cwd), /값을 입력/);
  assert.throws(
    () => parseArgs(['--category', '북미', '--category', '미국'], cwd),
    /한 번만/,
  );
  assert.throws(
    () => parseArgs(['--group', '관세', '--group', '수출통제'], cwd),
    /한 번만/,
  );
  assert.throws(
    () => parseArgs(['--group', '관세', '--category', 'customs:북미'], cwd),
    /함께 사용할 수 없습니다/,
  );
  assert.throws(
    () => parseArgs(['--list-categories', '--lookback', '24'], cwd),
    /다른 실행 옵션/,
  );
  assert.throws(
    () => parseArgs(['--list-groups', '--group', '관세'], cwd),
    /다른 실행 옵션/,
  );
  assert.throws(
    () => parseArgs(['--list-groups', '--list-categories'], cwd),
    /함께 사용할 수 없습니다/,
  );
  assert.throws(() => parseArgs(['--out', '--open'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--unknown'], cwd), /알 수 없는 인자/);
});

test('.env는 BOM·허용목록·엄격한 숫자 범위를 처리한다', async () => {
  await withTempDir(async (directory) => {
    const envFile = path.join(directory, '.env');
    await fs.writeFile(
      envFile,
      '\uFEFFCLAUDE_CLI_TIMEOUT_MS=900000\nGEMINI_CLI_TIMEOUT_MS=800000\nCODEX_CLI_RETRY_MAX=3\nUNSAFE_TOKEN=secret\nCLAUDE_CLI_MAX_TURNS=32\n',
      'utf8',
    );
    const target = {};
    const warnings = [];
    loadEnvFile(envFile, target, (warning) => warnings.push(warning));
    assert.equal(target.CLAUDE_CLI_TIMEOUT_MS, '900000');
    assert.equal(target.CLAUDE_CLI_MAX_TURNS, '32');
    assert.equal(target.GEMINI_CLI_TIMEOUT_MS, '800000');
    assert.equal(target.CODEX_CLI_RETRY_MAX, '3');
    assert.equal(target.UNSAFE_TOKEN, undefined);
    assert.match(warnings.join('\n'), /UNSAFE_TOKEN/);
    assert.doesNotThrow(() => validateRuntimeEnvironment(target));
    assert.throws(
      () => validateRuntimeEnvironment({ CLAUDE_CLI_TIMEOUT_MS: '600000 # comment' }),
      /정수/,
    );
    assert.throws(
      () => validateRuntimeEnvironment({ CLAUDE_CLI_ALLOWED_SHA256: 'not-a-hash' }),
      /64자리/,
    );
    assert.throws(
      () => validateRuntimeEnvironment({ GEMINI_CLI_RETRY_MAX: '4' }),
      /1~3/,
    );
    assert.throws(
      () => validateRuntimeEnvironment({ CODEX_RUN_TIMEOUT_MS: '0' }),
      /1~14400000/,
    );
    assert.doesNotThrow(() => validateRuntimeEnvironment({
      CLAUDE_CLI_TIMEOUT_MS: '600000',
      GEMINI_CLI_RETRY_MAX: '잘못된 미사용 값',
      CODEX_RUN_TIMEOUT_MS: '0',
    }, 'claude'));
    assert.throws(
      () => validateRuntimeEnvironment({ GEMINI_CLI_RETRY_MAX: '잘못된 값' }, 'gemini'),
      /정수/,
    );
    assert.doesNotThrow(() => validateRuntimeEnvironment({
      CLAUDE_CLI_TIMEOUT_MS: '잘못된 미사용 값',
      GEMINI_CLI_TIMEOUT_MS: '잘못된 미사용 값',
    }, 'chatgpt'));
    assert.doesNotThrow(() => validateRuntimeEnvironment({
      CLAUDE_CLI_TIMEOUT_MS: '잘못된 목 실행 미사용 값',
    }, 'none'));

    await fs.writeFile(envFile, 'CLAUDE_CLI_TIMEOUT_MS 900000\n', 'utf8');
    assert.throws(() => loadEnvFile(envFile, {}), /KEY=VALUE/);
  });
});

test('.env 심볼릭 링크를 일반 설정 파일로 따라가지 않는다', async (t) => {
  await withTempDir(async (directory) => {
    const outside = path.join(directory, 'outside.env');
    const linked = path.join(directory, '.env');
    await fs.writeFile(outside, 'CLAUDE_CLI_TIMEOUT_MS=900000\n', 'utf8');
    try {
      await fs.symlink(outside, linked, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) {
        t.skip(`현재 Windows 권한에서 심볼릭 링크 테스트 생략: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => loadEnvFile(linked, {}), /일반 파일/);
  });
});

test('전체·목·그룹·단일 카테고리 기본 결과 경로를 분리하고 명시한 --out을 우선한다', () => {
  const cliDir = path.resolve('example-cli');
  const configured = '.\\company\\full.html';
  const explicit = path.resolve('chosen.html');

  assert.equal(
    resolveMonitoringOutputFile(cliDir, {}, configured),
    path.resolve(cliDir, configured),
  );
  assert.equal(
    resolveMonitoringOutputFile(cliDir, { mockPath: 'fixture.json' }, configured),
    path.join(cliDir, 'output', 'mock-monitoring.html'),
  );
  assert.equal(
    resolveMonitoringOutputFile(cliDir, {
      categorySelection: { id: 'customs:북미', domainKey: 'customs', unitKey: '북미' },
    }, configured),
    path.join(cliDir, 'output', 'monitoring-customs-북미.html'),
  );
  for (const [domainKey, fileName] of [
    ['customs', 'monitoring-customs.html'],
    ['export', 'monitoring-export.html'],
    ['trade', 'monitoring-trade.html'],
  ]) {
    assert.equal(
      resolveMonitoringOutputFile(cliDir, { groupSelection: { domainKey } }, configured),
      path.join(cliDir, 'output', fileName),
    );
  }
  assert.equal(
    resolveMonitoringOutputFile(cliDir, {
      categorySelection: { id: 'customs:북미' },
      outputFile: explicit,
    }, configured),
    explicit,
  );
  assert.equal(
    resolveMonitoringOutputFile(cliDir, {
      groupSelection: { domainKey: 'customs' },
      outputFile: explicit,
    }, configured),
    explicit,
  );
  assert.throws(
    () => resolveMonitoringOutputFile(cliDir, { groupSelection: { domainKey: '../escape' } }, configured),
    /결정할 수 없습니다/,
  );
  assert.throws(
    () => resolveMonitoringOutputFile(cliDir, { groupSelection: { domainKey: 'constructor' } }, configured),
    /결정할 수 없습니다/,
  );
  assert.throws(
    () => resolveMonitoringOutputFile(cliDir, {
      categorySelection: { id: 'customs:북미' },
      groupSelection: { domainKey: 'customs' },
    }, configured),
    /함께 사용할 수 없습니다/,
  );
});

test('부분 결과 파일·네트워크 출력 경로·자동 조회기간을 안전하게 계산한다', async () => {
  await withTempDir(async (directory) => {
    const canonical = path.join(directory, 'monitoring.html');
    assert.equal(
      partialOutputFileFor(canonical, new Date('2026-08-10T01:02:03.456Z')),
      path.join(directory, 'monitoring.partial-20260810T010203456Z.html'),
    );
    assert.equal(isNetworkOutputPath('\\\\server\\share\\report.html'), true);
    assert.equal(isNetworkOutputPath('//server/share/report.html'), true);
    assert.equal(isNetworkOutputPath('\\\\?\\UNC\\server\\share\\report.html'), true);
    assert.equal(isNetworkOutputPath('\\\\?\\C:\\Reports\\report.html'), false);
    assert.equal(isNetworkOutputPath('C:\\Reports\\report.html'), false);
    if (process.platform === 'win32') {
      assert.throws(
        () => resolveMonitoringOutputFile(directory, {
          outputFile: '\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\report.html',
          allowNetworkOutput: true,
        }),
        /장치 네임스페이스/,
      );
      for (const [fileName, expected] of [
        ['NUL.html', /예약 장치 이름/],
        ['CON.html', /예약 장치 이름/],
        ['report:stream.html', /대체 데이터 스트림/],
      ]) {
        assert.throws(
          () => resolveMonitoringOutputFile(directory, {
            outputFile: path.join(directory, fileName),
          }),
          expected,
        );
      }
      assert.throws(
        () => resolveMonitoringOutputFile('\\\\server\\share\\cli', {
          mockPath: 'fixture.json',
        }),
        /--allow-network-output/,
      );
      assert.equal(
        resolveMonitoringOutputFile('\\\\server\\share\\cli', {
          mockPath: 'fixture.json',
          allowNetworkOutput: true,
        }),
        '\\\\server\\share\\cli\\output\\mock-monitoring.html',
      );
    }
    assert.throws(
      () => resolveMonitoringOutputFile(directory, {
        outputFile: '\\\\server\\share\\report.html',
      }),
      /--allow-network-output/,
    );
    assert.equal(
      resolveMonitoringOutputFile(directory, {
        outputFile: '\\\\server\\share\\report.html',
        allowNetworkOutput: true,
      }),
      '\\\\server\\share\\report.html',
    );

    const scope = monitoringScopeKey({
      categorySelection: { id: 'customs:북미' },
      depth: 'deep',
    });
    assert.equal(scope, 'category:customs:북미|depth:deep');
    await recordCompleteRun(directory, scope, {
      completedAt: '2026-08-10T00:00:00.000Z',
      outputFile: canonical,
      depth: 'deep',
    });
    const last = await lastCompleteRun(directory, scope);
    assert.equal(last.completedAt.toISOString(), '2026-08-10T00:00:00.000Z');
    assert.equal(
      automaticFromDate(new Date('2026-08-10T12:00:00.000Z'), last).toISOString(),
      '2026-08-09T18:00:00.000Z',
    );
    assert.equal(
      automaticFromDate(
        new Date('2026-08-10T12:00:00.000Z'),
        { completedAt: new Date('2026-07-01T00:00:00.000Z') },
      ).toISOString(),
      '2026-08-03T12:00:00.000Z',
    );
    assert.equal(
      automaticFromDate(
        new Date('2026-08-10T12:00:00.000Z'),
        { completedAt: new Date('2026-08-10T12:02:00.000Z') },
      ),
      null,
    );
  });
});

test('동시에 완료된 서로 다른 범위의 자동 조회 상태를 잃지 않는다', async () => {
  await withTempDir(async (directory) => {
    const writes = Array.from({ length: 20 }, (_, index) => recordCompleteRun(
      directory,
      `category:test-${index}|depth:standard`,
      {
        completedAt: new Date(Date.UTC(2026, 7, 10, 0, index)).toISOString(),
        outputFile: path.join(directory, `result-${index}.html`),
        depth: 'standard',
      },
    ));
    await Promise.all(writes);
    for (let index = 0; index < writes.length; index += 1) {
      const saved = await lastCompleteRun(directory, `category:test-${index}|depth:standard`);
      assert.equal(saved.completedAt.toISOString(), new Date(Date.UTC(2026, 7, 10, 0, index)).toISOString());
    }
  });
});

test('손상된 자동 조회 상태를 보존하고 다음 완전 성공부터 정상 복구한다', async () => {
  await withTempDir(async (directory) => {
    const stateDirectory = path.join(directory, 'output', '.trade-monitor-state');
    const stateFile = path.join(stateDirectory, 'state.json');
    await fs.mkdir(stateDirectory, { recursive: true });
    await fs.writeFile(stateFile, '{not-json', 'utf8');
    const scope = 'all|depth:standard';

    assert.equal(await lastCompleteRun(directory, scope), null);
    await recordCompleteRun(directory, scope, {
      completedAt: '2026-08-10T00:00:00.000Z',
      outputFile: path.join(directory, 'monitoring.html'),
      depth: 'standard',
    });
    assert.equal(
      (await lastCompleteRun(directory, scope)).completedAt.toISOString(),
      '2026-08-10T00:00:00.000Z',
    );
    const entries = await fs.readdir(stateDirectory);
    assert.equal(entries.filter((name) => name.startsWith('state.invalid-')).length, 1);
  });
});

test('같은 결과 파일의 동시 실행을 막고 정상 종료 시 잠금을 제거한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const first = await acquireRunLock(output);
    await assert.rejects(
      () => acquireRunLock(output),
      (error) => error.code === 'ALREADY_RUNNING',
    );
    await first.release();
    await assert.rejects(() => fs.access(lockPathFor(output)), /ENOENT/);

    const second = await acquireRunLock(output);
    await second.release();
  });
});

test('Windows는 죽은 PID의 오래된 진단 잠금을 자동 복구한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const lockFile = lockPathFor(output);
    await fs.writeFile(lockFile, JSON.stringify({
      pid: 2147483647,
      startedAt: '2000-01-01T00:00:00.000Z',
      token: 'stale',
    }), 'utf8');

    const lock = await acquireRunLock(output);
    assert.notEqual(lock.owner.token, 'stale');
    await lock.release();
  });
});

test('Windows에서 오래된 잠금을 여러 실행이 동시에 회수해도 하나만 획득한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const lockFile = lockPathFor(output);
    await fs.writeFile(lockFile, JSON.stringify({
      pid: 2147483647,
      startedAt: '2000-01-01T00:00:00.000Z',
      token: 'stale-race',
    }), 'utf8');

    const attempts = await Promise.allSettled(
      Array.from({ length: 24 }, () => acquireRunLock(output)),
    );
    const acquired = attempts
      .filter((attempt) => attempt.status === 'fulfilled')
      .map((attempt) => attempt.value);
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');

    assert.equal(acquired.length, 1);
    assert.equal(rejected.length, 23);
    assert.ok(rejected.every((attempt) => attempt.reason?.code === 'ALREADY_RUNNING'));
    await acquired[0].release();
  });
});

test('서로 다른 결과 파일은 동시에 실행할 수 있다', async () => {
  await withTempDir(async (directory) => {
    const [first, second] = await Promise.all([
      acquireRunLock(path.join(directory, 'first.html')),
      acquireRunLock(path.join(directory, 'second.html')),
    ]);
    await Promise.all([first.release(), second.release()]);
  });
});

test('POSIX 잠금 진단 해시는 대소문자가 다른 경로를 합치지 않는다', {
  skip: process.platform === 'win32',
}, async () => {
  await withTempDir(async (directory) => {
    const lockDirectory = path.join(directory, 'locks');
    assert.notEqual(
      lockPathFor(path.join(directory, 'Reports', 'A.html'), lockDirectory),
      lockPathFor(path.join(directory, 'reports', 'a.html'), lockDirectory),
    );
  });
});

test('중단된 HTML 교체의 복구 파일을 다음 실행에서 정리한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const recovery = recoveryFileFor(output);
    const previous = '<!DOCTYPE html><html><body>previous-good-result</body></html>';
    const current = '<!DOCTYPE html><html><body>new-result</body></html>';
    await writeRecoveryPair(output, previous);

    assert.equal(await recoverInterruptedOutput(output), true);
    assert.equal(await fs.readFile(output, 'utf8'), previous);
    await assert.rejects(() => fs.access(recovery), /ENOENT/);

    await fs.writeFile(output, current, 'utf8');
    await writeRecoveryPair(output, previous);
    assert.equal(await recoverInterruptedOutput(output), true);
    assert.equal(await fs.readFile(output, 'utf8'), current);
    await assert.rejects(() => fs.access(recovery), /ENOENT/);
  });
});

test('현재 결과가 손상됐으면 정상 복구 백업을 삭제하지 않는다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const recovery = recoveryFileFor(output);
    const previous = '<!DOCTYPE html><html><body>previous-good-result</body></html>';
    await fs.writeFile(output, '<html>truncated', 'utf8');
    await writeRecoveryPair(output, previous);

    await assert.rejects(
      () => recoverInterruptedOutput(output),
      (error) => error.code === 'OUTPUT_RECOVERY' && /백업을 삭제하지 않았습니다/.test(error.message),
    );
    assert.equal(await fs.readFile(recovery, 'utf8'), previous);
  });
});

test('소유 표식이 없는 같은 이름의 복구 파일은 삭제하거나 덮어쓰지 않는다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const recovery = recoveryFileFor(output);
    await fs.writeFile(output, '<!DOCTYPE html><html><body>current</body></html>', 'utf8');
    await fs.writeFile(recovery, '<!DOCTYPE html><html><body>user-file</body></html>', 'utf8');
    await assert.rejects(
      () => recoverInterruptedOutput(output),
      (error) => error.code === 'OUTPUT_RECOVERY' && /확인할 수 없어 보존/.test(error.message),
    );
    assert.match(await fs.readFile(recovery, 'utf8'), /user-file/);
  });
});

test('형식이 느슨한 복구 token은 소유 표식으로 인정하지 않는다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const recovery = recoveryFileFor(output);
    await fs.writeFile(recovery, '<!DOCTYPE html><html><body>preserve</body></html>', 'utf8');
    await fs.writeFile(recoveryManifestFor(output), JSON.stringify({
      app: 'trade-monitor-claude-cli',
      version: 1,
      outputFile: path.resolve(output),
      token: '------------------------------------',
    }), 'utf8');
    await assert.rejects(
      () => recoverInterruptedOutput(output),
      (error) => error.code === 'OUTPUT_RECOVERY',
    );
    assert.match(await fs.readFile(recovery, 'utf8'), /preserve/);
  });
});

test('한 시간 넘은 동일 출력의 중단 임시 파일만 다음 저장에서 정리한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const stale = path.join(directory, '.monitoring.html.00000000-0000-4000-8000-000000000000.tmp');
    await fs.writeFile(stale, 'stale', 'utf8');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    await saveHtmlOutput('<!DOCTYPE html><html><body>new</body></html>', output);
    assert.deepEqual(await fs.readdir(directory), ['monitoring.html']);
  });
});
