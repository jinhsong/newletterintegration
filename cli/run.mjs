import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderNewsletterHtml } from './src/email-renderer.mjs';
import {
  acquireOutputLock,
  resolveOutputRoot,
  saveHtmlOutput,
} from './src/output-store.mjs';
import {
  buildMarkdownSummary,
  collectWithGeminiCli,
} from './src/pipeline.mjs';
import {
  attachMockSources,
  attachValidatedSources,
} from './src/source-validator.mjs';

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
  node run.mjs [--lookback 24|72|168] [--skip-insights]
               [--run-key KEY] [--out DIR] [--mock FILE]

Gemini CLI로 뉴스를 조사해 다음 파일을 PC에 저장합니다.
  output/latest/newsletter.html
  output/latest/summary.md
  output/latest/result.json

각 실행 결과는 output/archive 아래에도 별도로 보존됩니다.
메일 발송이나 외부 저장소 업로드는 하지 않습니다.
`);
}

function parseArgs(argv) {
  const output = { skipInsights: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-insights') output.skipInsights = true;
    else if (arg === '--lookback') output.lookbackHours = Number.parseInt(argv[++index], 10);
    else if (arg === '--run-key') output.deliveryKey = argv[++index];
    else if (arg === '--out') output.outDir = path.resolve(argv[++index]);
    else if (arg === '--mock') output.mockPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') output.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (output.deliveryKey && !/^[a-zA-Z0-9._-]{1,80}$/.test(output.deliveryKey)) {
    throw new Error('run-key는 영문자, 숫자, 점, 밑줄, 하이픈만 허용합니다.');
  }
  return output;
}

function envPositiveInt(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name}은 1~${maximum} 사이 정수여야 합니다.`);
  }
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }

  const outputRoot = resolveOutputRoot(
    cliDir,
    process.env.LOCAL_OUTPUT_DIR,
    options.outDir,
  );
  const releaseLock = await acquireOutputLock(outputRoot);
  try {
    const payload = await collectWithGeminiCli(options);
    const sourceResult = options.mockPath
      ? attachMockSources(payload)
      : await attachValidatedSources(payload, {
        maxUrls: envPositiveInt('SOURCE_VALIDATE_MAX', 40, 200),
        concurrency: envPositiveInt('SOURCE_VALIDATE_CONCURRENCY', 5, 20),
        timeoutMs: envPositiveInt('SOURCE_VALIDATE_TIMEOUT_MS', 8000, 60000),
      });
    console.log(`출처 URL 검증: ${sourceResult.accepted}/${sourceResult.candidates}건 채택`);

    const saved = await saveHtmlOutput(payload, {
      outputRoot,
      html: renderNewsletterHtml(payload),
      markdown: buildMarkdownSummary(payload),
    });
    console.log(`HTML 저장 완료: ${saved.htmlPath}`);
    console.log(`실행별 보관 폴더: ${saved.runDir}`);
    console.log('메일을 발송하거나 외부 저장소에 업로드하지 않았습니다.');

    if (payload.failedUnits.length > 0) {
      console.warn(`경고: ${payload.failedUnits.length}개 수집 단위 실패 — summary.md를 확인하세요.`);
    }
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  console.error(`실행 실패: ${error.message}`);
  process.exitCode = 1;
});
