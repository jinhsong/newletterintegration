import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  domains, groupCatalog, resolveCategorySelector, researchPolicyForUnit,
  useSfu5ofProfile, validateOfficialSources, unitCount,
} from '../src/config.mjs';
import { collectMonitoring, createContext, parseDomainResponse } from '../src/pipeline.mjs';

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(cliDir);
const runFile = path.join(cliDir, 'company.mjs');
const fixture = path.join(cliDir, 'test', 'fixtures', 'company-responses.json');
useSfu5ofProfile();

function run(args) {
  return spawnSync(process.execPath, [runFile, ...args], {
    cwd: repoRoot,
    env: { ...process.env, CLAUDE_CLI_BIN: 'definitely-missing-company-claude', LOCAL_OUTPUT_FILE: '' },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
}

test('sfu5of 원본의 세 영역과 17개 카테고리·순서를 그대로 유지한다', async () => {
  const source = await fs.readFile(path.join(repoRoot, '01_Config.gs'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const original = JSON.parse(JSON.stringify(context.DOMAINS.map((domain) => ({
    key: domain.key, labels: domain.units.map((unit) => unit.label),
  }))));
  assert.deepEqual(domains.map((domain) => ({
    key: domain.key, labels: domain.units.map((unit) => unit.label),
  })), original);
  assert.equal(unitCount, 17);
  assert.deepEqual(groupCatalog.map((group) => group.unitCount), [9, 5, 3]);
  for (const domain of domains) {
    for (const unit of domain.units) {
      assert.equal(validateOfficialSources(unit.officialSources), true);
      assert.ok(researchPolicyForUnit(unit).minimumSearchesPerCategory >= 6);
    }
  }
});

test('기존 수출통제 식별자와 동남아 카테고리를 선택할 수 있다', () => {
  for (const [alias, label] of [['US', '미국'], ['KR', '한국'], ['EUJP', 'EU/일본'], ['CNVN', '중국/베트남'], ['UNETC', 'UN 및 기타']]) {
    assert.equal(resolveCategorySelector(`export:${alias}`).unitKey, label);
  }
  assert.equal(resolveCategorySelector('customs:동남아').unitKey, '동남아');
  assert.equal(resolveCategorySelector('export:UN 및 기타').unitKey, 'UN 및 기타');
});

test('중국 관세와 UN 및 기타의 검색 범위가 다른 국가로 넓어지지 않는다', () => {
  const china = resolveCategorySelector('customs:중국');
  assert.deepEqual(china.coverageTargets.map((target) => target.label), ['중국']);
  assert.deepEqual(china.officialDomains, ['gov.cn']);
  assert.equal(china.itemScope.aliases.includes('Japan'), false);
  const un = resolveCategorySelector('export:UNETC');
  assert.equal(un.officialDomains.includes('gov.uk'), false);
  assert.throws(() => resolveCategorySelector('export:영국/캐나다/호주/인도'), /알 수 없는 카테고리/);
});

test('잘못된 응답과 null 항목은 정상 무동향으로 처리하지 않는다', () => {
  const domain = domains[0];
  const unit = domain.units[0];
  const context = createContext(new Date('2026-10-15T00:00:00Z'), 24);
  for (const response of ['일반 설명입니다.', '{"error":"failed"}', '[]']) {
    assert.throws(() => parseDomainResponse(domain, response, context, { units: [unit] }),
      (error) => error.code === 'BAD_JSON');
  }
  const invalid = parseDomainResponse(domain, {
    domain: 'customs', categories: { [unit.key]: [null] },
  }, context, { units: [unit] });
  assert.equal(invalid.categoryStatus[unit.key].status, 'failure');
  const empty = parseDomainResponse(domain, {
    domain: 'customs', categories: { [unit.key]: [] },
  }, context, { units: [unit] });
  assert.equal(empty.categoryStatus[unit.key].status, 'empty');
});

test('회사 실행기의 목록과 도움말은 Claude 로그인 없이 확인할 수 있다', () => {
  const listed = run(['--list-categories']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal((listed.stdout.match(/^  (?:customs|export|trade):/gm) || []).length, 17);
  const groups = run(['--list-groups']);
  assert.equal(groups.status, 0, groups.stderr);
  assert.match(groups.stdout, /수출통제  \(5개 카테고리\)/);
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /회사 Claude CLI/);
  assert.doesNotMatch(help.stdout, /claude\|gemini\|chatgpt/);
  const rejected = run(['--provider', 'gemini']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /회사 Claude CLI/);
});

test('회사 전용 mock은 17개 카테고리를 조사하고 자체 포함 HTML을 저장한다', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-company-test-'));
  try {
    const output = path.join(directory, '회사 보고서.html');
    const result = run(['--mock', fixture, '--out', output, '--no-open']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /완료 카테고리: 17\/17/);
    assert.doesNotMatch(result.stdout, /호출 모델을 선택하세요/);
    const html = await fs.readFile(output, 'utf8');
    assert.match(html, /MOCK · 테스트 전용/);
    assert.match(html, /기존 통합 모니터링 · 17개 분류/);
    assert.match(html, /UN 및 기타/);
    assert.doesNotMatch(html, /<(?:script|img|iframe|link)\b/i);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('원본 식별자로 단일 카테고리를 조사하고 전체 범위로 표시하지 않는다', async () => {
  const result = await collectMonitoring({
    mockPath: fixture, category: 'export:US', lookbackHours: 24,
    now: new Date('2026-10-15T00:00:00Z'), provider: 'claude',
  });
  assert.equal(result.collection.totalCategories, 1);
  assert.equal(result.collection.completedCategories, 1);
  assert.equal(result.collection.selection.unitKey, '미국');
  assert.deepEqual(result.collection.requestedCategoryIds, ['export:미국']);
});
