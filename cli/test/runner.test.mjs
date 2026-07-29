import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { domains, repoRoot } from '../src/config-loader.mjs';
import { collectWithGeminiCli, createContext } from '../src/pipeline.mjs';
import { parseJsonArray, parseJsonObject } from '../src/json-utils.mjs';

test('공통 .gs 소스가 JavaScript 문법으로 파싱된다', async () => {
  const names = (await fs.readdir(repoRoot)).filter((name) => name.endsWith('.gs'));
  assert.equal(names.length, 9);
  for (const name of names) {
    const source = await fs.readFile(path.join(repoRoot, name), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }));
  }
});

test('설정에서 3개 도메인과 17개 수집 단위를 로드한다', () => {
  assert.equal(domains.length, 3);
  assert.equal(domains.reduce((sum, domain) => sum + domain.units.length, 0), 17);
});

test('KST 월요일은 기본 72시간, 화요일은 24시간을 사용한다', () => {
  const monday = createContext(new Date('2026-07-27T00:00:00Z'));
  const tuesday = createContext(new Date('2026-07-28T00:00:00Z'));
  assert.equal(monday.lookbackHours, 72);
  assert.equal(tuesday.lookbackHours, 24);
});

test('마크다운 fence와 부가 텍스트가 섞인 JSON을 복구한다', () => {
  assert.deepEqual(parseJsonArray('설명\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(parseJsonObject('결과: {"overall":"ok"}'), { overall: 'ok' });
});

test('fixture는 유효한 JSON이며 임시 경로에서 치환할 수 있다', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = await fs.readFile(path.join(here, 'fixtures', 'responses.json'), 'utf8');
  const today = '2026-07-29';
  const fixture = JSON.parse(raw.replaceAll('__TODAY__', today));
  assert.equal(fixture.units['customs/북미'][0]['발표일'], today);

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-test-'));
  try {
    await fs.writeFile(path.join(temp, 'responses.json'), JSON.stringify(fixture), 'utf8');
    assert.ok((await fs.stat(path.join(temp, 'responses.json'))).isFile());
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('mock 수집이 공통 스키마 payload를 만든다', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixture = path.join(here, 'fixtures', 'responses.json');
  const payload = await collectWithGeminiCli({
    now: new Date('2026-07-29T00:00:00Z'),
    lookbackHours: 24,
    mockPath: fixture,
  });
  assert.equal(payload.version, 1);
  assert.equal(payload.deliveryKey, '2026-07-29');
  assert.equal(payload.stats.total, 2);
  assert.equal(payload.data.customs['북미'][0].__modelUrl, 'https://ustr.gov/example');
  assert.equal(payload.data.export.US[0].__modelUrl, 'https://www.bis.gov/example');
  assert.equal(payload.insights.customs.overall, '시험 관세 인사이트입니다.');
});
