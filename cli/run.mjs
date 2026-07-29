import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { buildMarkdownSummary, collectWithGeminiCli } from './src/pipeline.mjs';

const cliDir = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadEnvFile(path.join(cliDir, '.env'));

function help() {
  console.log(`
사용법:
  node run.mjs [--deliver] [--lookback 24|72|168] [--skip-insights]
               [--delivery-key KEY] [--out DIR] [--force]
               [--mock FILE]

기본 동작은 로컬 결과만 생성합니다. --deliver를 주면 CLI_INBOX_PATH에
pending JSON을 기록하고, Apps Script의 processCliInbox()가 이를 발송합니다.
`);
}

function parseArgs(argv) {
  const out = {
    deliver: false,
    force: false,
    skipInsights: false,
    outDir: path.join(cliDir, 'output'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--deliver') out.deliver = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--skip-insights') out.skipInsights = true;
    else if (arg === '--lookback') out.lookbackHours = Number.parseInt(argv[++i], 10);
    else if (arg === '--delivery-key') out.deliveryKey = argv[++i];
    else if (arg === '--out') out.outDir = path.resolve(argv[++i]);
    else if (arg === '--mock') out.mockPath = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (out.deliveryKey && !/^[a-zA-Z0-9._-]{1,80}$/.test(out.deliveryKey)) {
    throw new Error('delivery-key는 영문자, 숫자, 점, 밑줄, 하이픈만 허용합니다.');
  }
  return out;
}

async function writeAtomic(target, content, force) {
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) && !force) {
    throw new Error(`이미 파일이 있습니다: ${target}\n덮어쓰려면 --force를 사용하세요.`);
  }
  const temp = `${target}.${process.pid}.tmp`;
  await fsPromises.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
  if (fs.existsSync(target)) await fsPromises.unlink(target);
  await fsPromises.rename(temp, target);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }

  const payload = await collectWithGeminiCli(options);
  const runDir = path.join(
    options.outDir,
    `${payload.deliveryKey}-${payload.runId.slice(-8)}`,
  );
  await fsPromises.mkdir(runDir, { recursive: true });
  await fsPromises.writeFile(
    path.join(runDir, 'result.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf8',
  );
  await fsPromises.writeFile(
    path.join(runDir, 'summary.md'),
    buildMarkdownSummary(payload),
    'utf8',
  );
  console.log(`로컬 결과: ${runDir}`);

  if (options.deliver) {
    const inbox = process.env.CLI_INBOX_PATH;
    if (!inbox) throw new Error('CLI_INBOX_PATH가 없습니다. cli/.env를 설정하세요.');
    const stat = await fsPromises.stat(inbox).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`CLI_INBOX_PATH 폴더를 찾을 수 없습니다: ${inbox}`);
    }
    const pending = path.join(
      inbox,
      `trade-monitor-pending-${payload.deliveryKey}.json`,
    );
    await writeAtomic(pending, `${JSON.stringify(payload)}\n`, options.force);
    console.log(`Drive inbox 전달 완료: ${pending}`);
  } else {
    console.log('발송하지 않았습니다. 실제 전달은 --deliver 옵션을 사용하세요.');
  }

  if (payload.failedUnits.length > 0) {
    console.warn(`경고: ${payload.failedUnits.length}개 수집 단위 실패 — summary.md를 확인하세요.`);
  }
}

main().catch((error) => {
  console.error(`실행 실패: ${error.message}`);
  process.exitCode = 1;
});
