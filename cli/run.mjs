import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './src/cli-args.mjs';
import {
  categoryCatalog,
  groupCatalog,
  resolveCategorySelector,
  resolveGroupSelector,
} from './src/config.mjs';
import {
  prepareResearchWorkspace,
  preflightClaudeCli,
  stopAllClaudeProcesses,
  totalTimeoutMs,
} from './src/claude-client.mjs';
import { renderMonitoringHtml } from './src/html-renderer.mjs';
import { collectMonitoring } from './src/pipeline.mjs';
import { acquireRunLock } from './src/run-lock.mjs';
import {
  resolveMonitoringOutputFile,
  saveHtmlOutput,
} from './src/output-store.mjs';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(cliDir);
const LOCAL_ENV_KEYS = new Set([
  'CLAUDE_CLI_BIN',
  'CLAUDE_CLI_MODEL',
  'CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS',
  'CLAUDE_CLI_RETRY_MAX',
  'CLAUDE_CLI_TIMEOUT_MS',
  'CLAUDE_RUN_TIMEOUT_MS',
  'LOCAL_OUTPUT_FILE',
]);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    if (!LOCAL_ENV_KEYS.has(key)) {
      console.warn(`cli/.env의 허용되지 않은 설정을 무시했습니다: ${key}`);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadEnvFile(path.join(cliDir, '.env'));

function help() {
  console.log(`
사용법:
  node run.mjs [--lookback 24|72|168] [--group GROUP | --category CATEGORY] [--out FILE] [--open|--no-open]
  node run.mjs --list-groups
  node run.mjs --list-categories
  node run.mjs --mock test/fixtures/responses.json [--out FILE]

회사 계정으로 로그인된 Claude Code CLI를 사용해 통상 동향을 조사하고
PC에 HTML 파일 하나만 저장합니다.

기본 결과: cli/output/monitoring.html
그룹별 기본 결과: cli/output/monitoring-customs.html | monitoring-export.html | monitoring-trade.html
단일 카테고리 기본 결과: cli/output/monitoring-category.html
목 테스트 기본 결과: cli/output/mock-monitoring.html
`);
}

function listGroups() {
  console.log('사용 가능한 그룹(--group 값):');
  for (const entry of groupCatalog) {
    console.log(`  ${entry.id} 또는 ${entry.domainLabel}  (${entry.unitCount}개 카테고리)`);
  }
  console.log('');
  console.log('예: .\\run-monitoring.cmd --group "관세"');
}

function listCategories() {
  console.log('사용 가능한 카테고리(--category 값):');
  for (const entry of categoryCatalog) {
    console.log(`  ${entry.id}  (${entry.domainLabel} · ${entry.description})`);
  }
  console.log('');
  console.log('예: .\\run-monitoring.cmd --category "customs:북미"');
}

async function createResearchWorkspace() {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-claude-'));
  try {
    await prepareResearchWorkspace(directory);
    return directory;
  } catch (error) {
    await removeResearchWorkspace(directory).catch(() => {});
    throw error;
  }
}

async function removeResearchWorkspace(directory) {
  if (!directory) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${tempRoot}${path.sep}`)
    || !path.basename(resolved).startsWith('trade-monitor-claude-')) {
    throw new Error(`임시 작업 폴더 경로가 안전하지 않아 삭제하지 않았습니다: ${resolved}`);
  }
  await fsPromises.rm(resolved, { recursive: true, force: true });
}

function openHtml(filePath) {
  const command = process.platform === 'win32'
    ? { bin: 'explorer.exe', args: [filePath] }
    : process.platform === 'darwin'
      ? { bin: 'open', args: [filePath] }
      : { bin: 'xdg-open', args: [filePath] };
  const child = spawn(command.bin, command.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => {
    console.warn(`브라우저를 자동으로 열지 못했습니다: ${error.message}`);
    console.warn(`결과 파일을 직접 여세요: ${filePath}`);
  });
  child.unref();
}

function throwIfAborted(signal, code = 'ABORTED') {
  if (!signal.aborted) return;
  // 전체 제한시간 도달은 이미 pipeline이 미조사 범위를 표시했으므로 부분 HTML 저장을 허용한다.
  if (signal.reason?.code === 'RUN_TIMEOUT') return;
  const error = new Error('사용자가 실행을 중단했습니다.');
  error.code = code;
  throw error;
}

async function main() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`Node.js 20 이상이 필요합니다. 현재 버전: ${process.versions.node}`);
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.listGroups) {
    listGroups();
    return;
  }
  if (options.listCategories) {
    listCategories();
    return;
  }
  if (options.help) {
    help();
    return;
  }
  const categorySelection = options.category
    ? resolveCategorySelector(options.category)
    : null;
  const groupSelection = options.group
    ? resolveGroupSelector(options.group)
    : null;

  const outputFile = resolveMonitoringOutputFile(
    cliDir,
    { ...options, categorySelection, groupSelection },
    process.env.LOCAL_OUTPUT_FILE,
  );
  const controller = new AbortController();
  let interrupted = false;
  let runLock;
  let researchWorkspace;
  let deadlineTimer;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    console.warn('\n중단 요청을 받았습니다. 실행 중인 Claude 작업을 정리합니다...');
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    runLock = await acquireRunLock(outputFile);
    if (!options.mockPath) {
      researchWorkspace = await createResearchWorkspace();
      console.log('Claude Code CLI 버전과 실행기 보안 설정을 확인합니다...');
      const preflight = await preflightClaudeCli({ cwd: researchWorkspace, signal: controller.signal });
      console.log(`Claude Code ${preflight.version} 확인 완료.`);
      const deadline = totalTimeoutMs();
      console.log(`전체 실행 제한: ${Math.round(deadline / 60000)}분`);
      deadlineTimer = setTimeout(() => {
        const error = new Error(
          `전체 실행 제한 ${Math.round(deadline / 60000)}분을 초과해 남은 범위를 중단했습니다.`,
        );
        error.code = 'RUN_TIMEOUT';
        controller.abort(error);
      }, deadline);
      deadlineTimer.unref();
    }
    const payload = await collectMonitoring({
      cwd: researchWorkspace || repoRoot,
      lookbackHours: options.lookbackHours,
      categorySelection,
      groupSelection,
      mockPath: options.mockPath,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    if (payload.collection.completedDomains === 0) {
      const subject = categorySelection
        ? `선택한 ${categorySelection.domainLabel} / ${categorySelection.unitLabel} 카테고리가`
        : groupSelection
          ? `선택한 ${groupSelection.domainLabel} 그룹이`
          : '전체 조사 범위가';
      const error = new Error(`${subject} 실패하여 기존 HTML을 덮어쓰지 않았습니다. 위 오류 코드를 확인하세요.`);
      if (payload.failures.some((failure) => failure.code === 'RUN_TIMEOUT')) error.code = 'RUN_TIMEOUT';
      throw error;
    }

    const html = renderMonitoringHtml(payload);
    throwIfAborted(controller.signal);
    await saveHtmlOutput(html, outputFile);
    throwIfAborted(controller.signal, 'ABORTED_AFTER_SAVE');
    console.log('');
    console.log(`HTML 저장 완료: ${outputFile}`);
    console.log(`수집 결과: 총 ${payload.stats.total}건 / 중요도 상 ${payload.stats.high}건`);
    if (payload.failures.length > 0) {
      console.warn(`주의: ${payload.failures.length}개 카테고리 실패가 HTML 상단에 표시되었습니다.`);
    }
    console.log('메일 발송, 예약 실행, 외부 저장은 수행하지 않았습니다.');
    if (options.open) {
      throwIfAborted(controller.signal, 'ABORTED_AFTER_SAVE');
      openHtml(outputFile);
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await stopAllClaudeProcesses();
    const cleanup = await Promise.allSettled([
      removeResearchWorkspace(researchWorkspace),
      runLock?.release(),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        console.warn(`임시 실행 정보 정리 경고: ${result.reason?.message || result.reason}`);
      }
    }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

main().catch((error) => {
  if (error?.code === 'ABORTED_AFTER_SAVE') {
    console.error('중단 요청이 HTML 교체 중 접수되어 파일 저장은 안전하게 마쳤지만 브라우저는 열지 않았습니다.');
    process.exitCode = 130;
    return;
  }
  if (error?.code === 'ABORTED') {
    console.error('실행을 중단했습니다. Claude 프로세스와 임시 실행 정보를 정리했습니다.');
    process.exitCode = 130;
    return;
  }
  console.error(`실행 실패: ${error.message}`);
  if (error?.details) console.error(`상세: ${error.details}`);
  if (error?.code) console.error(`오류 코드: ${error.code}`);
  process.exitCode = 1;
});
