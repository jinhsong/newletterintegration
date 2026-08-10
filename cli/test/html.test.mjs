import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { domains, researchPolicyForUnit } from '../src/config.mjs';
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
  assert.doesNotMatch(html, /@import|@font-face|url\s*\(/i);
  assert.doesNotMatch(html, /<(?:iframe|object|embed|audio|video|source)\b/i);
  assert.match(html, /--canvas:#eef1f5;--navy:#0d1b30;--gold:#ffd54f/);
  assert.match(html, /max-width:680px/);
  assert.match(html, /"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",Arial,sans-serif/);
  assert.match(html, /--domain-band:#13335f;--domain-cat-bg:#eaf1fa;--domain-cat-border:#1a4d8f;--domain-cat-text:#15406f;--domain-chip:#1a4d8f/);
  assert.match(html, /--domain-band:#7a1f1f;--domain-cat-bg:#fbeded;--domain-cat-border:#9c2a2a;--domain-cat-text:#8a2424;--domain-chip:#9c2a2a/);
  assert.match(html, /--domain-band:#1b5e3b;--domain-cat-bg:#e9f4ee;--domain-cat-border:#1e7045;--domain-cat-text:#1a5e3a;--domain-chip:#1e7045/);
  assert.match(html, /--high:#c62828;--high-bg:#fdecea;--mid:#ef6c00;--mid-bg:#fff3e0;--low:#2e7d32;--low-bg:#e8f5e9/);
  assert.match(html, /--importance-color:#c62828;--importance-bg:#fdecea;--importance-text:#c62828/);
  assert.match(html, /--importance-color:#ef6c00;--importance-bg:#fff3e0;--importance-text:#8a4b00/);
  assert.match(html, /PART 1/);
  assert.match(html, /① 관세 동향/);
  assert.match(html, /② 수출통제 동향/);
  assert.match(html, /③ 무역구제 동향/);
  assert.ok(html.indexOf('>관세<') < html.indexOf('>수출통제<'));
  assert.ok(html.indexOf('>수출통제<') < html.indexOf('>무역구제<'));
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /AI 예비 조사 결과 · 원문 수동 확인 필수/);
  assert.match(html, /<title>\[테스트 전용\] 글로벌 통상 모니터링 · 전체 · 2026-07-29<\/title>/);
  assert.match(html, /<body class="mock-output">/);
  assert.match(html, /MOCK · 테스트 전용/);
  assert.match(html, /실제 모니터링 결과나 업무 판단 자료로 사용하지 마세요/);
  assert.match(html, /자체 포함 HTML/);
  assert.match(html, /외부 서비스 연동 및 메일 발송 없음/);
  assert.doesNotMatch(html, /PC 로컬 HTML/);
  assert.match(html, /발표시각이 확인된 항목은 정확한 시각/);
  assert.match(html, /<span class="sr-only">\(새 창\)<\/span>/);
  assert.match(html, /완료 카테고리 18\/18 · 완전 완료 영역 3\/3/);
  assert.match(html, /검증 처리/);
  assert.match(html, /검증 제외 0건/);
  assert.match(html, /표시 한도 제외 0건/);
  assert.match(html, /중복 제거 0건/);
  assert.match(html, /aria-label="카테고리 바로가기"/);
  assert.match(html, /id="category-customs-1"/);
  assert.match(html, /href="#category-customs-1"/);
  assert.match(html, /class="back-to-top" href="#top"/);
  assert.equal([...html.matchAll(/id="category-[^"]+"/g)].length, 18);
  assert.equal([...html.matchAll(/class="back-to-top"/g)].length, 18);
  assert.match(html, /조사 기간 하이라이트/);
  assert.match(html, /a:focus-visible\{outline:3px solid var\(--navy\);outline-offset:2px;box-shadow:0 0 0 6px var\(--gold\)/);
  assert.match(html, /\.source\[href\]::after\{content:" \(" attr\(href\) "\)"/);
  assert.match(html, /break-after:avoid-page;page-break-after:avoid/);
  assert.doesNotMatch(html, /--muted:#7c8b9a/);
  assert.doesNotMatch(html, /color:#9aa7b4/);
  assert.doesNotMatch(html, /정상적으로 완료/);
});

test('중요도 하 카드도 원본 녹색 팔레트와 좌측 강조선을 사용한다', async () => {
  const payload = await mockPayload();
  payload.results.customs.categories.북미[0].importance = '하';
  const html = renderMonitoringHtml(payload);
  assert.match(html, /--importance-color:#2e7d32;--importance-bg:#e8f5e9;--importance-text:#2e7d32/);
  assert.match(html, /border-left:5px solid var\(--importance-color\)/);
});

test('단일 카테고리 HTML은 선택 범위만 표시하고 미선택 17개를 숨긴다', async () => {
  const payload = await collectMonitoring({
    mockPath: fixture,
    category: 'export:미국',
    now: new Date('2026-07-29T00:00:00Z'),
    lookbackHours: 24,
  });
  payload.collection.mode = 'live';
  payload.results.export.coverage.webSearchSuccesses = 6;
  payload.results.export.categoryStatus.미국.webSearchSuccesses = 6;
  const html = renderMonitoringHtml(payload);
  assert.match(html, /<title>글로벌 통상 모니터링 · 수출통제 \/ 미국 · 2026-07-29<\/title>/);
  assert.match(html, /<body class="live-output">/);
  assert.match(html, /선택 조사 · 수출통제 \/ 미국/);
  assert.match(html, /요청한 1개 카테고리의 Claude Code 표준 조사를 정리했습니다/);
  assert.match(html, /조사 깊이 표준\(standard\)/);
  assert.match(html, /카테고리 1\/1 · 웹 검색 6회 성공/);
  assert.match(html, /--domain-band:#7a1f1f/);
  assert.doesNotMatch(html, /--domain-band:#13335f/);
  assert.doesNotMatch(html, /--domain-band:#1b5e3b/);
  assert.match(html, /PART 1/);
  assert.match(html, /① 수출통제 동향/);
  assert.doesNotMatch(html, /PART 2/);
  assert.match(html, />미국</);
  assert.doesNotMatch(html, />한국</);
  assert.doesNotMatch(html, />북미</);
  assert.doesNotMatch(html, />반덤핑</);
  assert.doesNotMatch(html, /17개 카테고리/);
});

test('그룹 HTML은 선택한 영역의 전체 카테고리만 표시한다', async () => {
  const payload = await collectMonitoring({
    mockPath: fixture,
    group: '관세',
    now: new Date('2026-07-29T00:00:00Z'),
    lookbackHours: 24,
  });
  payload.collection.mode = 'live';
  const customs = domains.find((domain) => domain.key === 'customs');
  let expectedSearches = 0;
  for (const unit of customs.units) {
    const searches = researchPolicyForUnit(unit, 'standard').minimumSearchesPerCategory;
    payload.results.customs.categoryStatus[unit.key].webSearchSuccesses = searches;
    expectedSearches += searches;
  }
  payload.results.customs.coverage.webSearchSuccesses = expectedSearches;
  assert.equal(expectedSearches, 60);
  const html = renderMonitoringHtml(payload);
  assert.equal(payload.collection.scope, 'group');
  assert.equal(payload.collection.totalCategories, 9);
  assert.ok(payload.collection.requestedCategoryIds.every((id) => id.startsWith('customs:')));
  assert.match(html, /선택 그룹 · 관세 · 9개 카테고리/);
  assert.match(html, /<title>글로벌 통상 모니터링 · 관세 그룹 · 2026-07-29<\/title>/);
  assert.match(html, /요청한 9개 카테고리의 Claude Code 표준 조사를 정리했습니다/);
  assert.match(html, /카테고리 9\/9 · 웹 검색 60회 성공/);
  assert.match(html, /id="domain-customs"/);
  assert.doesNotMatch(html, /id="domain-export"/);
  assert.doesNotMatch(html, /id="domain-trade"/);
  assert.match(html, /--domain-band:#13335f/);
  assert.doesNotMatch(html, /--domain-band:#7a1f1f/);
  assert.doesNotMatch(html, /--domain-band:#1b5e3b/);
  assert.match(html, /PART 1/);
  assert.doesNotMatch(html, /PART 2/);
  assert.doesNotMatch(html, /undefined/);
});

test('조사 기간 근처에 발표일의 시각·날짜 정밀도 한계를 표시한다', async () => {
  const payload = await mockPayload();
  payload.context.lookbackSource = 'last-complete-run';
  const html = renderMonitoringHtml(payload);
  const periodStart = html.indexOf('<div class="period">');
  const periodEnd = html.indexOf('</div>', periodStart);
  const period = html.slice(periodStart, periodEnd);
  assert.match(period, /발표시각이 확인된 항목은 정확한 시각, 나머지는 KST 달력 날짜 기준/);
  assert.match(html, /기간 계산:<\/b> 동일 범위·깊이의 마지막 완전 성공 시각에서 6시간 중첩/);
});

test('모델 텍스트는 한 번만 HTML escape되고 위험한 URL은 링크가 되지 않는다', async () => {
  const payload = await mockPayload();
  const item = payload.results.customs.categories.북미[0];
  item.title = '<img src=x onerror=alert(1)>';
  item.summary = '<script>alert(1)</script>';
  item.announcedDate = 'A&B';
  item.sourceUrl = 'javascript:alert(1)';
  const html = renderMonitoringHtml(payload);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<b>발표<\/b> A&amp;B/);
  assert.doesNotMatch(html, /A&amp;amp;B/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /안전한 HTTPS 원문 URL 없음/);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<script\b/i);
});

test('출처명과 실제 hostname을 함께 표시한다', async () => {
  const payload = await mockPayload();
  const item = payload.results.customs.categories.북미[0];
  item.sourceName = 'USTR 기관';
  item.sourceUrl = 'https://ustr.gov/example';
  item.sourceVerification = 'format-only';
  const html = renderMonitoringHtml(payload);
  assert.match(html, /<span class="source-name">USTR 기관<\/span>/);
  assert.match(html, /<span class="source-host">ustr\.gov<\/span>/);
  assert.match(html, />원문 열기 /);
  assert.match(html, /HTTPS 형식 확인 · 원문 수동 확인 필요/);

  item.sourceUrl = 'https://user:pass@ustr.gov/private';
  assert.doesNotMatch(renderMonitoringHtml(payload), /href="https:\/\/user:pass@/);
  item.sourceUrl = 'https://localhost/internal';
  assert.doesNotMatch(renderMonitoringHtml(payload), /href="https:\/\/localhost/);
  item.sourceUrl = 'https://intranet.lan/internal';
  assert.doesNotMatch(renderMonitoringHtml(payload), /href="https:\/\/intranet\.lan/);
});

test('정확한 발표시각이 있으면 날짜와 함께 HTML에 표시한다', async () => {
  const payload = await mockPayload();
  payload.results.customs.categories.북미[0].announcedAt = '2026-07-29T08:30:00+09:00';
  const html = renderMonitoringHtml(payload);
  assert.match(html, /<b>발표시각<\/b> 2026-07-29T08:30:00\+09:00/);
});

test('웹 검색 성공 기록이 0이면 완료 배너로 과장하지 않는다', async () => {
  const payload = await mockPayload();
  for (const result of Object.values(payload.results)) {
    result.coverage.webSearchSuccesses = 0;
  }
  const html = renderMonitoringHtml(payload);
  assert.match(html, /검색 상태 확인 필요/);
  assert.match(html, /웹 검색 성공 기록 없음/);
  assert.match(html, /검색 상태 정보 없음/);
  assert.doesNotMatch(html, /세 영역의 Claude Code 조사 결과를 정리했습니다/);
});

test('검증 제외·표시 한도 제외·중복 제거 건수를 감사 칩으로 표시한다', async () => {
  const payload = await mockPayload();
  Object.assign(payload.results.customs.categoryStatus.북미, {
    rejectedCount: 3,
    truncatedCount: 2,
    dedupedCount: 1,
  });
  Object.assign(payload.results.export.categoryStatus.미국, {
    rejectedCount: 4,
    truncatedCount: 1,
    dedupedCount: 2,
  });

  const html = renderMonitoringHtml(payload);
  assert.match(html, /검증 제외 7건/);
  assert.match(html, /표시 한도 제외 3건/);
  assert.match(html, /중복 제거 3건/);

  payload.audit = { rejected: 10, truncated: 8, deduped: 6 };
  const explicitAuditHtml = renderMonitoringHtml(payload);
  assert.match(explicitAuditHtml, /검증 제외 10건/);
  assert.match(explicitAuditHtml, /표시 한도 제외 8건/);
  assert.match(explicitAuditHtml, /중복 제거 6건/);
});

test('부분 실패, 확인 불가, 검색 후 0건을 영역과 카테고리에서 구분한다', async () => {
  const payload = await mockPayload();
  payload.collection.completedDomains = 2;
  payload.results.trade.coverage = {
    requestedCategories: 3,
    completedCategories: 2,
    failedCategories: 1,
    webSearchSuccesses: 12,
    warningCount: 1,
    complete: false,
  };
  payload.results.trade.categoryStatus = {
    '반덤핑': {
      status: 'failure', coverage: 'none', itemCount: 0, reason: '<정책 차단>',
    },
    '세이프가드': {
      status: 'empty', coverage: 'full', itemCount: 0, reason: '',
    },
    '보조금/상계관세': {
      status: 'empty', coverage: 'fallback', itemCount: 0, reason: '',
    },
  };
  const html = renderMonitoringHtml(payload);
  assert.match(html, /일부 범위 조사 실패/);
  assert.match(html, /부분 결과/);
  assert.match(html, /카테고리 2\/3 · 웹 검색 12회 성공 · Claude 경고 1건/);
  assert.match(html, /수집 실패로 확인할 수 없습니다/);
  assert.match(html, /사유: &lt;정책 차단&gt;/);
  assert.match(html, /웹 검색을 마쳤으며, 조사 기간과 포함 기준을 충족한 신규 동향은 0건입니다/);
  assert.match(html, /재조사 · 검색 실행 · 0건/);
});

test('구버전 payload의 빈 카테고리를 검색 완료로 과장하지 않는다', async () => {
  const payload = await mockPayload();
  for (const result of Object.values(payload.results)) {
    delete result.coverage;
    delete result.categoryStatus;
  }
  const html = renderMonitoringHtml(payload);
  assert.match(html, /검색 상태 확인 필요/);
  assert.match(html, /상태 정보 없음/);
  assert.match(html, /검색 상태 정보가 없어 신규 동향 유무를 판단할 수 없습니다/);
  assert.doesNotMatch(html, /세 영역의 Claude Code 조사 결과를 정리했습니다/);
});

test('Executive Watch는 영역 균형을 보존하고 선정된 6건을 발표일 최신순으로 표시한다', async () => {
  const payload = await mockPayload();
  const base = payload.results.customs.categories.북미[0];
  payload.results.customs.categories.중남미 = [
    ['관세 추가 1', '2026-07-28'],
    ['관세 추가 2', '2026-07-27'],
    ['관세 추가 3', '2026-07-26'],
    ['관세 추가 4', '2026-07-25'],
  ].map(([title, announcedDate]) => ({ ...base, title, announcedDate }));
  Object.assign(payload.results.export.categories.미국[0], {
    importance: '상', title: '수출통제 균형 항목', announcedDate: '2026-07-20',
  });
  payload.results.trade.categories.반덤핑 = [{
    ...base, title: '무역구제 균형 항목', announcedDate: '2026-07-19',
  }];

  const html = renderMonitoringHtml(payload);
  const start = html.indexOf('<section class="priority">');
  const end = html.indexOf('</section>', start);
  const priority = html.slice(start, end);
  assert.match(priority, /6\/7건 표시/);
  assert.match(priority, /수출통제 균형 항목/);
  assert.match(priority, /무역구제 균형 항목/);
  assert.doesNotMatch(priority, /관세 추가 4/);
  assert.ok(priority.indexOf('관세 추가 1') < priority.indexOf('관세 추가 2'));
  assert.match(priority, /<h3>/);
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
    const html = await fs.readFile(output, 'utf8');
    assert.match(html, /글로벌 통상 모니터링/);
    assert.match(html, /AI 예비 조사 · 원문 수동 확인 필수<\/b> · v6\.0\.0/);
    assert.deepEqual(await fs.readdir(path.dirname(output)), ['monitoring.html']);
  });
});

test('전체 요청 카테고리가 모두 실패하면 기존 HTML을 보존한다', async () => {
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

test('선택한 단일 카테고리가 실패하면 기존 단일 HTML을 보존한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring-category.html');
    const failedFixture = path.join(directory, 'failed-category.json');
    await fs.writeFile(output, 'previous-single-result', 'utf8');
    await fs.writeFile(failedFixture, JSON.stringify({
      domains: {
        customs: { __error: { code: 'TIMEOUT', message: '선택 조사 시간 초과' } },
      },
    }), 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(cliDir, 'run.mjs'),
      '--mock', failedFixture,
      '--category', 'customs:북미',
      '--out', output,
      '--lookback', '24',
    ], { cwd: cliDir, encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /선택한 관세 \/ 북미 카테고리가 실패/);
    assert.equal(await fs.readFile(output, 'utf8'), 'previous-single-result');
    assert.deepEqual(
      (await fs.readdir(directory)).sort(),
      ['failed-category.json', 'monitoring-category.html'],
    );
  });
});

test('선택한 그룹 전체가 실패하면 기존 그룹 HTML을 보존한다', async () => {
  await withTempDir(async (directory) => {
    const output = path.join(directory, 'monitoring-customs.html');
    const failedFixture = path.join(directory, 'failed-group.json');
    await fs.writeFile(output, 'previous-group-result', 'utf8');
    await fs.writeFile(failedFixture, JSON.stringify({
      domains: {
        customs: { __error: { code: 'TIMEOUT', message: '그룹 조사 시간 초과' } },
      },
    }), 'utf8');

    const result = spawnSync(process.execPath, [
      path.join(cliDir, 'run.mjs'),
      '--mock', failedFixture,
      '--group', '관세',
      '--out', output,
      '--lookback', '24',
    ], { cwd: cliDir, encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /선택한 관세 그룹이 실패/);
    assert.equal(await fs.readFile(output, 'utf8'), 'previous-group-result');
    assert.deepEqual(
      (await fs.readdir(directory)).sort(),
      ['failed-group.json', 'monitoring-customs.html'],
    );
  });
});
