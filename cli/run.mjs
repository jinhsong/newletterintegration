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
  resolveWindowsSystemExecutable,
  stopAllProviderProcesses,
} from './src/claude-client.mjs';
import { completeInteractiveOptions } from './src/interactive-options.mjs';
import { resolveProvider } from './src/provider-registry.mjs';
import { renderMonitoringHtml } from './src/html-renderer.mjs';
import { collectMonitoring } from './src/pipeline.mjs';
import { acquireRunLock } from './src/run-lock.mjs';
import { loadEnvFile, validateRuntimeEnvironment } from './src/runtime-config.mjs';
import {
  isNetworkOutputPath,
  partialOutputFileFor,
  resolveMonitoringOutputFile,
  saveHtmlOutput,
} from './src/output-store.mjs';
import {
  appStateDirectory,
  globalResearchLockTarget,
} from './src/run-state.mjs';
import { APP_VERSION } from './src/version.mjs';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(cliDir);
const DEFAULT_RUN_TIMEOUT_BY_DEPTH_MS = Object.freeze({
  fast: 60 * 60 * 1000,
  standard: 120 * 60 * 1000,
  deep: 240 * 60 * 1000,
});
const ownedResearchWorkspaces = new Set();

function help() {
  console.log(`
사용법:
  .\\run-monitoring.cmd [--provider claude|gemini|chatgpt]
                         [--depth fast|standard|deep] [--lookback 1~168]
                         [--group GROUP | --category CATEGORY] [--out FILE]
                         [--open|--no-open] [--allow-partial-overwrite]
                         [--allow-parallel] [--allow-network-output]
  .\\run-monitoring.cmd --list-groups
  .\\run-monitoring.cmd --list-categories
  .\\run-monitoring.cmd --mock .\\cli\\test\\fixtures\\responses.json [--out FILE]
  .\\run-monitoring.cmd --version

회사 계정으로 로그인된 Claude, Gemini 또는 ChatGPT(Codex) CLI를 사용해 통상 동향을 조사하고
PC에 HTML 파일 하나만 저장합니다.

옵션 없이 실행하면 호출 모델과 기간을 질문합니다.
빈 입력 기본값: Claude / 월요일 72시간 / 그 외 요일 24시간

기본 결과: cli/output/monitoring.html
그룹별 기본 결과: cli/output/monitoring-customs.html | monitoring-export.html | monitoring-trade.html
단일 카테고리 기본 결과: cli/output/monitoring-{영역}-{카테고리}.html
목 테스트 기본 결과: cli/output/mock-monitoring.html

기본 조사 깊이: standard
기본 조사 기간: 월요일 72시간, 그 외 요일 24시간
부분 결과: 대표 파일을 보존하고 timestamp가 붙은 별도 파일로 저장(종료 코드 2)
부분 결과 대표 파일 교체: --allow-partial-overwrite
동시 조사 허용(주의): --allow-parallel
UNC 네트워크 공유 저장 허용: --allow-network-output
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

async function createResearchWorkspace(provider) {
  const configuredTempRoot = os.tmpdir();
  if (!path.isAbsolute(configuredTempRoot)
    || isNetworkOutputPath(configuredTempRoot)
    || (process.platform === 'win32' && /^\\\\[?.]\\/.test(configuredTempRoot))) {
    const error = new Error('OS 임시 폴더가 로컬 일반 절대경로가 아니어서 AI 조사를 시작하지 않았습니다.');
    error.code = 'SECURITY_POLICY';
    throw error;
  }
  const rootStat = await fsPromises.lstat(configuredTempRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    const error = new Error('OS 임시 폴더가 일반 로컬 폴더가 아닙니다.');
    error.code = 'SECURITY_POLICY';
    throw error;
  }
  const tempRoot = await fsPromises.realpath(configuredTempRoot);
  if (isNetworkOutputPath(tempRoot)) {
    const error = new Error('네트워크 임시 폴더에서는 AI 조사를 실행하지 않습니다.');
    error.code = 'SECURITY_POLICY';
    throw error;
  }
  const directory = await fsPromises.mkdtemp(path.join(tempRoot, provider.workspacePrefix));
  const resolvedDirectory = path.resolve(directory);
  ownedResearchWorkspaces.add(resolvedDirectory);
  try {
    await provider.prepareWorkspace(resolvedDirectory);
    return resolvedDirectory;
  } catch (error) {
    await removeResearchWorkspace(resolvedDirectory).catch(() => {});
    throw error;
  }
}

async function removeResearchWorkspace(directory) {
  if (!directory) return;
  const resolved = path.resolve(directory);
  if (!ownedResearchWorkspaces.has(resolved)
    || !path.basename(resolved).startsWith('trade-monitor-')) {
    throw new Error(`임시 작업 폴더 경로가 안전하지 않아 삭제하지 않았습니다: ${resolved}`);
  }
  await fsPromises.rm(resolved, { recursive: true, force: true });
  ownedResearchWorkspaces.delete(resolved);
}

async function openHtml(filePath) {
  const command = process.platform === 'win32'
    ? { bin: await resolveWindowsSystemExecutable('explorer.exe'), args: [filePath] }
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
  let options = parseArgs(process.argv.slice(2));
  if (options.version) {
    console.log(`trade-monitor-cli ${APP_VERSION}`);
    return;
  }
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
  loadEnvFile(path.join(cliDir, '.env'));
  options = await completeInteractiveOptions(options);
  validateRuntimeEnvironment(process.env, options.mockPath ? 'none' : options.provider);
  const provider = resolveProvider(options.provider);
  console.log(`호출 모델: ${provider.cliLabel}`);
  console.log(`모니터링 기간: ${options.lookbackHours === undefined
    ? '요일 기본값(월요일 72시간, 그 외 24시간)'
    : `최근 ${options.lookbackHours}시간`}`);
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
  const runStartedAt = new Date();
  const controller = new AbortController();
  let interrupted = false;
  let outputRunLock;
  let globalRunLock;
  let researchWorkspace;
  let preflight;
  let deadlineTimer;
  let deadlineAt;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    console.warn(`\n중단 요청을 받았습니다. 실행 중인 ${provider.label} 작업을 정리합니다...`);
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    const lockDirectory = appStateDirectory(cliDir);
    if (!options.mockPath && !options.allowParallel) {
      globalRunLock = await acquireRunLock(globalResearchLockTarget(cliDir), {
        lockDirectory,
        description: '다른 AI 모니터링',
      });
    }
    outputRunLock = await acquireRunLock(outputFile, { lockDirectory });
    if (!options.mockPath) {
      researchWorkspace = await createResearchWorkspace(provider);
      console.log(`${provider.cliLabel} 버전과 실행기 보안 설정을 확인합니다...`);
      preflight = await provider.preflight({ cwd: researchWorkspace, signal: controller.signal });
      console.log(`${provider.cliLabel} ${preflight.version} 확인 완료.`);
      if (preflight.executablePath) console.log(`${provider.label} 실행 파일: ${preflight.executablePath}`);
      for (const warning of preflight.diagnostics?.warnings || []) {
        console.warn(`실행 환경 주의: ${warning}`);
      }
      const deadline = process.env[provider.runTimeoutEnv] === undefined
        ? DEFAULT_RUN_TIMEOUT_BY_DEPTH_MS[options.depth]
        : provider.totalTimeoutMs();
      deadlineAt = Date.now() + deadline;
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
      now: runStartedAt,
      lookbackHours: options.lookbackHours,
      depth: options.depth,
      provider: provider.key,
      categorySelection,
      groupSelection,
      mockPath: options.mockPath,
      signal: controller.signal,
      deadlineAt,
    });
    payload.appVersion = APP_VERSION;
    payload.runtime = {
      cliVersion: preflight?.version || (options.mockPath ? 'mock' : ''),
      model: String(process.env[provider.modelEnv] || '').trim() || 'CLI 기본값',
      authMethod: preflight?.diagnostics?.authMethod || (options.mockPath ? 'mock' : '첫 조사에서 회사 로그인 확인'),
      evidenceMode: provider.evidenceMode,
    };
    payload.context.lookbackSource = options.lookbackHours !== undefined
      ? 'manual'
      : 'weekday-default';
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

    const complete = payload.failures.length === 0
      && payload.collection.completedCategories === payload.collection.totalCategories
      && payload.collection.fullyCompletedDomains === payload.collection.totalDomains;
    const savedOutputFile = complete || options.allowPartialOverwrite
      ? outputFile
      : partialOutputFileFor(outputFile, payload.createdAt);
    const html = renderMonitoringHtml(payload);
    throwIfAborted(controller.signal);
    await saveHtmlOutput(html, savedOutputFile);
    throwIfAborted(controller.signal, 'ABORTED_AFTER_SAVE');
    console.log('');
    const saveLabel = complete
      ? 'HTML 저장 완료'
      : options.allowPartialOverwrite
        ? '부분 HTML 대표 파일 저장 완료'
        : '부분 HTML 별도 저장 완료';
    console.log(`${saveLabel}: ${savedOutputFile}`);
    console.log(`수집 결과: 총 ${payload.stats.total}건 / 중요도 상 ${payload.stats.high}건`);
    console.log(`완료 카테고리: ${payload.collection.completedCategories}/${payload.collection.totalCategories}`);
    if (!complete) {
      console.warn(`주의: ${payload.failures.length}개 카테고리 실패 또는 미완료 범위가 HTML 상단에 표시되었습니다.`);
      if (options.allowPartialOverwrite) {
        console.warn(`--allow-partial-overwrite에 따라 대표 결과를 부분 결과로 교체했습니다: ${outputFile}`);
      } else {
        console.warn(`기존 대표 결과는 보존했습니다: ${outputFile}`);
      }
    }
    console.log('메일 발송, 예약 실행, 외부 서비스 저장은 수행하지 않았습니다.');
    if (options.open) {
      throwIfAborted(controller.signal, 'ABORTED_AFTER_SAVE');
      await openHtml(savedOutputFile);
    }
    if (!complete) process.exitCode = 2;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    const processCleanup = await stopAllProviderProcesses();
    if (!processCleanup.ok && process.exitCode !== 130) process.exitCode = 1;
    const cleanup = await Promise.allSettled([
      removeResearchWorkspace(researchWorkspace),
      outputRunLock?.release(),
      globalRunLock?.release(),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        console.warn(`임시 실행 정보 정리 경고: ${result.reason?.message || result.reason}`);
        if (process.exitCode !== 130) process.exitCode = 1;
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
    console.error('실행을 중단했습니다. AI CLI 프로세스와 임시 실행 정보를 정리했습니다.');
    process.exitCode = 130;
    return;
  }
  console.error(`실행 실패: ${error.message}`);
  if (error?.details) console.error(`상세: ${error.details}`);
  if (error?.code) console.error(`오류 코드: ${error.code}`);
  process.exitCode = 1;
});
