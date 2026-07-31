import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDomainPrompt,
  domains,
  unitCount,
} from '../src/config.mjs';
import {
  collectMonitoring,
  createContext,
  parseDomainResponse,
  safeSourceUrl,
} from '../src/pipeline.mjs';
import { parseJsonArray, parseJsonObject } from '../src/json-utils.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testDir, 'fixtures', 'responses.json');

test('순수 Node 설정에 3개 영역과 17개 카테고리가 있다', () => {
  assert.deepEqual(domains.map((domain) => domain.label), ['관세', '수출통제', '무역구제']);
  assert.equal(unitCount, 17);
  assert.deepEqual(domains.map((domain) => domain.units.map((unit) => unit.key)), [
    ['북미', '중남미', '인도', '유럽', '중동', '동남아', '아프리카', 'CIS', '중국'],
    ['미국', '한국', 'EU/일본', '중국/베트남', 'UN 및 다자체제'],
    ['반덤핑', '세이프가드', '보조금/상계관세'],
  ]);
});

test('영역 프롬프트는 모든 카테고리와 로컬 작업 금지 규칙을 포함한다', () => {
  const context = createContext(new Date('2026-07-29T00:00:00Z'), 24);
  for (const domain of domains) {
    const prompt = buildDomainPrompt(domain, context);
    for (const unit of domain.units) assert.ok(prompt.includes(unit.key));
    assert.match(prompt, /Google 웹 검색/);
    assert.match(prompt, /파일을 읽거나 수정하지 말고/);
  }
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

test('공개 HTTPS 링크만 남기고 로컬·인증정보 URL은 제거한다', () => {
  assert.equal(safeSourceUrl('https://example.com/a#part'), 'https://example.com/a');
  assert.equal(safeSourceUrl('http://example.com'), '');
  assert.equal(safeSourceUrl('https://127.0.0.1/admin'), '');
  assert.equal(safeSourceUrl('https://user:pass@example.com'), '');
});

test('영역 응답에서 날짜 범위 밖 항목과 알 수 없는 카테고리를 제거한다', () => {
  const context = createContext(new Date('2026-07-29T00:00:00Z'), 24);
  const response = {
    domain: 'customs',
    insight: '확인',
    categories: Object.fromEntries(domains[0].units.map((unit) => [unit.key, []])),
  };
  response.categories.북미 = [
        { title: '유효', announcedDate: '2026-07-29', importance: '상' },
        { title: '오래됨', announcedDate: '2026-07-01', importance: '상' },
  ];
  response.categories.가짜 = [{ title: '제외', announcedDate: '2026-07-29' }];
  const parsed = parseDomainResponse(domains[0], response, context);
  assert.deepEqual(parsed.categories.북미.map((item) => item.title), ['유효']);
  assert.equal(Object.hasOwn(parsed.categories, '가짜'), false);
});

test('domain 또는 카테고리 배열이 누락된 응답은 성공으로 처리하지 않는다', () => {
  const context = createContext(new Date('2026-07-29T00:00:00Z'), 24);
  assert.throws(
    () => parseDomainResponse(domains[0], { domain: 'wrong', categories: {} }, context),
    /domain 값/,
  );
  assert.throws(
    () => parseDomainResponse(domains[0], { domain: 'customs', categories: {} }, context),
    /배열이 없습니다/,
  );
});

test('mock 수집은 Gemini 호출 없이 공통 payload를 만든다', async () => {
  const payload = await collectMonitoring({
    mockPath: fixture,
    now: new Date('2026-07-29T00:00:00Z'),
    lookbackHours: 24,
  });
  assert.equal(payload.version, 2);
  assert.equal(payload.collection.completedDomains, 3);
  assert.equal(payload.stats.total, 2);
  assert.equal(payload.stats.high, 1);
  assert.equal(payload.results.customs.categories.북미[0].sourceUrl, 'https://ustr.gov/example');
  assert.equal(payload.results.export.categories.미국[0].sourceUrl, 'https://www.bis.gov/example');
});
