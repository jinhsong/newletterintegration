import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli-args.mjs';
import {
  recoverInterruptedOutput,
  recoveryFileFor,
  resolveMonitoringOutputFile,
  saveHtmlOutput,
} from '../src/output-store.mjs';
import {
  acquireRunLock,
  lockPathFor,
} from '../src/run-lock.mjs';

async function withTempDir(worker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-runtime-'));
  try {
    return await worker(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('CLI 인자는 lookback·단일 카테고리·값이 있는 경로만 받는다', () => {
  const cwd = path.resolve('example-root');
  const parsed = parseArgs([
    '--lookback', '72',
    '--category', 'customs:북미',
    '--out', 'result.html',
    '--open',
  ], cwd);
  assert.equal(parsed.lookbackHours, 72);
  assert.equal(parsed.category, 'customs:북미');
  assert.equal(parsed.outputFile, path.resolve(cwd, 'result.html'));
  assert.equal(parsed.open, true);

  assert.equal(parseArgs(['--category', 'UN 및 다자체제'], cwd).category, 'UN 및 다자체제');
  assert.equal(parseArgs(['--list-categories', '--open'], cwd).listCategories, true);
  assert.throws(() => parseArgs(['--lookback', 'abc'], cwd), /24, 72, 168/);
  assert.throws(() => parseArgs(['--lookback'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--category'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--category', '   '], cwd), /값을 입력/);
  assert.throws(
    () => parseArgs(['--category', '북미', '--category', '미국'], cwd),
    /한 번만/,
  );
  assert.throws(
    () => parseArgs(['--list-categories', '--lookback', '24'], cwd),
    /다른 실행 옵션/,
  );
  assert.throws(() => parseArgs(['--out', '--open'], cwd), /값을 입력/);
  assert.throws(() => parseArgs(['--unknown'], cwd), /알 수 없는 인자/);
});

test('전체·목·단일 카테고리 기본 결과 경로를 분리하고 명시한 --out을 우선한다', () => {
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
    resolveMonitoringOutputFile(cliDir, { categorySelection: { id: 'customs:북미' } }, configured),
    path.join(cliDir, 'output', 'monitoring-category.html'),
  );
  assert.equal(
    resolveMonitoringOutputFile(cliDir, {
      categorySelection: { id: 'customs:북미' },
      outputFile: explicit,
    }, configured),
    explicit,
  );
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

test('중단된 HTML 교체의 복구 파일을 다음 실행에서 정리한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const recovery = recoveryFileFor(output);
    const previous = '<!DOCTYPE html><html><body>previous-good-result</body></html>';
    const current = '<!DOCTYPE html><html><body>new-result</body></html>';
    await fs.writeFile(recovery, previous, 'utf8');

    assert.equal(await recoverInterruptedOutput(output), true);
    assert.equal(await fs.readFile(output, 'utf8'), previous);
    await assert.rejects(() => fs.access(recovery), /ENOENT/);

    await fs.writeFile(output, current, 'utf8');
    await fs.writeFile(recovery, previous, 'utf8');
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
    await fs.writeFile(recovery, previous, 'utf8');

    await assert.rejects(
      () => recoverInterruptedOutput(output),
      (error) => error.code === 'OUTPUT_RECOVERY' && /백업을 삭제하지 않았습니다/.test(error.message),
    );
    assert.equal(await fs.readFile(recovery, 'utf8'), previous);
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
