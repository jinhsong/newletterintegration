import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopAllGeminiProcesses } from './src/gemini-client.mjs';
import { renderMonitoringHtml } from './src/html-renderer.mjs';
import { collectMonitoring } from './src/pipeline.mjs';
import {
  resolveOutputFile,
  saveHtmlOutput,
} from './src/output-store.mjs';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(cliDir);

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
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadEnvFile(path.join(cliDir, '.env'));

function help() {
  console.log(`
사용법:
  node run.mjs [--lookback 24|72|168] [--out FILE] [--open]
  node run.mjs --mock test/fixtures/responses.json [--out FILE]

회사 계정으로 로그인된 Gemini CLI를 사용해 통상 동향을 조사하고
PC에 HTML 파일 하나만 저장합니다.

기본 결과: cli/output/monitoring.html
`);
}

function parseArgs(argv) {
  const options = { open: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lookback') options.lookbackHours = Number.parseInt(argv[++index], 10);
    else if (arg === '--out') options.outputFile = path.resolve(process.cwd(), argv[++index]);
    else if (arg === '--mock') options.mockPath = path.resolve(process.cwd(), argv[++index]);
    else if (arg === '--open') options.open = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  return options;
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

async function main() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`Node.js 20 이상이 필요합니다. 현재 버전: ${process.versions.node}`);
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }

  const outputFile = resolveOutputFile(
    cliDir,
    process.env.LOCAL_OUTPUT_FILE,
    options.outputFile,
  );
  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) return;
    interrupted = true;
    console.warn('\n중단 요청을 받았습니다. 실행 중인 Gemini 작업을 정리합니다...');
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    const payload = await collectMonitoring({
      cwd: repoRoot,
      lookbackHours: options.lookbackHours,
      mockPath: options.mockPath,
      signal: controller.signal,
    });
    if (payload.collection.completedDomains === 0) {
      throw new Error('세 영역이 모두 실패하여 기존 HTML을 덮어쓰지 않았습니다. 위 오류 코드를 확인하세요.');
    }

    const html = renderMonitoringHtml(payload);
    await saveHtmlOutput(html, outputFile);
    console.log('');
    console.log(`HTML 저장 완료: ${outputFile}`);
    console.log(`수집 결과: 총 ${payload.stats.total}건 / 중요도 상 ${payload.stats.high}건`);
    if (payload.failures.length > 0) {
      console.warn(`주의: ${payload.failures.length}개 영역 실패가 HTML 상단에 표시되었습니다.`);
    }
    console.log('메일 발송, 예약 실행, 외부 저장은 수행하지 않았습니다.');
    if (options.open) openHtml(outputFile);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
    await stopAllGeminiProcesses();
  }
}

main().catch((error) => {
  if (error?.code === 'ABORTED') {
    console.error('실행을 중단했습니다. 잠금 파일과 Gemini 프로세스를 정리했습니다.');
    process.exitCode = 130;
    return;
  }
  console.error(`실행 실패: ${error.message}`);
  process.exitCode = 1;
});
