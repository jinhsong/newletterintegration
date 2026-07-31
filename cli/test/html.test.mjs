import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderMonitoringHtml } from '../src/html-renderer.mjs';
import { saveHtmlOutput } from '../src/output-store.mjs';
import { collectMonitoring } from '../src/pipeline.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.dirname(testDir);
const fixture = path.join(testDir, 'fixtures', 'responses.json');

async function withTempDir(worker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-html-'));
  try {
    return await worker(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function mockPayload() {
  return collectMonitoring({
    mockPath: fixture,
    now: new Date('2026-07-29T00:00:00Z'),
    lookbackHours: 24,
  });
}

test('HTML은 자체 포함 CSS와 세 영역을 가지며 외부 리소스와 스크립트가 없다', async () => {
  const html = renderMonitoringHtml(await mockPayload());
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<style>/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.ok(html.indexOf('>관세<') < html.indexOf('>수출통제<'));
  assert.ok(html.indexOf('>수출통제<') < html.indexOf('>무역구제<'));
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('모델 텍스트는 HTML로 escape되고 위험한 URL은 링크가 되지 않는다', async () => {
  const payload = await mockPayload();
  const item = payload.results.customs.categories.북미[0];
  item.title = '<img src=x onerror=alert(1)>';
  item.summary = '<script>alert(1)</script>';
  item.sourceUrl = '';
  const html = renderMonitoringHtml(payload);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<script\b/i);
});

test('부분 실패는 HTML 상단에 완성도와 오류 코드로 표시된다', async () => {
  const payload = await mockPayload();
  payload.collection.completedDomains = 2;
  payload.failures.push({
    domainKey: 'trade',
    domainLabel: '무역구제',
    code: 'TIMEOUT',
    reason: '시간 초과',
  });
  const html = renderMonitoringHtml(payload);
  assert.match(html, /일부 영역 수집 실패/);
  assert.match(html, /2\/3개 영역 완료/);
  assert.match(html, /TIMEOUT/);
});

test('단일 HTML을 원자적으로 교체한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, '결과 폴더', 'monitoring.html');
    await saveHtmlOutput('first', output);
    await saveHtmlOutput('second', output);
    assert.equal(await fs.readFile(output, 'utf8'), 'second');
    assert.deepEqual(await fs.readdir(path.dirname(output)), ['monitoring.html']);
  });
});

test('run.mjs mock 실행은 HTML 한 파일만 만든다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, '회사 결과', 'monitoring.html');
    const result = spawnSync(process.execPath, [
      path.join(cliDir, 'run.mjs'),
      '--mock', fixture,
      '--out', output,
      '--lookback', '24',
    ], { cwd: cliDir, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(await fs.readFile(output, 'utf8'), /글로벌 통상 모니터링/);
    assert.deepEqual(await fs.readdir(path.dirname(output)), ['monitoring.html']);
  });
});

test('세 영역이 모두 실패하면 기존 HTML을 보존한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring.html');
    const failedFixture = path.join(directory, 'failed.json');
    await fs.writeFile(output, 'previous-good-result', 'utf8');
    await fs.writeFile(failedFixture, JSON.stringify({
      domains: Object.fromEntries(['customs', 'export', 'trade'].map((key) => [key, {
        __error: { code: 'TIMEOUT', message: '시험 시간 초과' },
      }])),
    }), 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(cliDir, 'run.mjs'),
      '--mock', failedFixture,
      '--out', output,
      '--lookback', '24',
    ], { cwd: cliDir, encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.equal(await fs.readFile(output, 'utf8'), 'previous-good-result');
    assert.deepEqual((await fs.readdir(directory)).sort(), ['failed.json', 'monitoring.html']);
  });
});
