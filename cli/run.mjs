import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  deliverNewsletter,
  sendTestNewsletter,
} from './src/delivery.mjs';
import { renderNewsletterHtml } from './src/email-renderer.mjs';
import {
  acquireRunLock,
  appendHistory,
  loadDeliveryPayload,
  loadDeliveryState,
  loadHistoryTitles,
  resolveDataDir,
  saveDeliveryPayload,
} from './src/local-store.mjs';
import {
  buildMarkdownSummary,
  collectWithGeminiCli,
  createContext,
} from './src/pipeline.mjs';
import {
  isValidEmail,
  loadRecipients,
  resolveRecipientsPath,
} from './src/recipients.mjs';
import {
  smtpConfigFromEnv,
  verifySmtp,
} from './src/smtp-client.mjs';
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
  node run.mjs [--send] [--test-email 주소] [--check-smtp]
               [--lookback 24|72|168] [--skip-insights]
               [--delivery-key KEY] [--out DIR] [--mock FILE]

  옵션 없음             Gemini CLI 수집 + 로컬 HTML/JSON/Markdown 생성
  --send                recipients.csv의 enabled=Y 수신자에게 사내 SMTP 발송
  --test-email 주소      지정 주소 한 곳에 [시험] 메일 발송(이력/중복키 미기록)
  --check-smtp           수집 없이 SMTP 연결/TLS/인증만 확인
  --mock FILE            Gemini 대신 테스트 fixture 사용(--send와 함께 사용 불가)
`);
}

function parseArgs(argv) {
  const output = {
    send: false,
    skipInsights: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--send') output.send = true;
    else if (arg === '--test-email') output.testEmail = argv[++index];
    else if (arg === '--check-smtp') output.checkSmtp = true;
    else if (arg === '--skip-insights') output.skipInsights = true;
    else if (arg === '--lookback') output.lookbackHours = Number.parseInt(argv[++index], 10);
    else if (arg === '--delivery-key') output.deliveryKey = argv[++index];
    else if (arg === '--out') output.outDir = path.resolve(argv[++index]);
    else if (arg === '--mock') output.mockPath = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') output.help = true;
    else throw new Error(`알 수 없는 인자: ${arg}`);
  }
  if (output.send && output.testEmail) throw new Error('--send와 --test-email은 함께 사용할 수 없습니다.');
  if (output.checkSmtp && (output.send || output.testEmail || output.mockPath)) {
    throw new Error('--check-smtp는 다른 실행/발송 옵션과 함께 사용할 수 없습니다.');
  }
  if (output.send && output.mockPath) throw new Error('모의 데이터는 전체 수신자에게 발송할 수 없습니다. --test-email을 사용하세요.');
  if (output.deliveryKey && !/^[a-zA-Z0-9._-]{1,80}$/.test(output.deliveryKey)) {
    throw new Error('delivery-key는 영문자, 숫자, 점, 밑줄, 하이픈만 허용합니다.');
  }
  if (output.testEmail && !isValidEmail(output.testEmail)) {
    throw new Error(`시험 이메일 주소 형식이 잘못됐습니다: ${output.testEmail}`);
  }
  return output;
}

function envPositiveInt(name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name}은 1~${maximum} 사이 정수여야 합니다.`);
  }
  return parsed;
}

async function saveRunOutput(payload, outputRoot) {
  const runDir = path.join(
    outputRoot,
    `${payload.deliveryKey}-${payload.runId.slice(-8)}`,
  );
  await fsPromises.mkdir(runDir, { recursive: true });
  await Promise.all([
    fsPromises.writeFile(
      path.join(runDir, 'result.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
      'utf8',
    ),
    fsPromises.writeFile(
      path.join(runDir, 'summary.md'),
      buildMarkdownSummary(payload),
      'utf8',
    ),
    fsPromises.writeFile(
      path.join(runDir, 'newsletter.html'),
      renderNewsletterHtml(payload),
      'utf8',
    ),
  ]);
  return runDir;
}

async function collectPayload(options, dataDir, deliveryKey) {
  if (options.send) {
    const state = await loadDeliveryState(dataDir, deliveryKey);
    if (state.status === 'completed') {
      throw new Error(`이미 발송 완료된 날짜입니다: ${deliveryKey}`);
    }
    const saved = await loadDeliveryPayload(dataDir, deliveryKey);
    if (saved) {
      console.log(`부분 발송 재개: 저장된 payload 사용 (${deliveryKey})`);
      return saved;
    }
  }

  const historyTitles = options.send
    ? await loadHistoryTitles(dataDir, envPositiveInt('HISTORY_LOOKBACK_DAYS', 7, 30))
    : null;
  const payload = await collectWithGeminiCli({
    ...options,
    deliveryKey,
    historyTitles,
  });
  const sourceResult = options.mockPath
    ? attachMockSources(payload)
    : await attachValidatedSources(payload, {
      maxUrls: envPositiveInt('SOURCE_VALIDATE_MAX', 40, 200),
      concurrency: envPositiveInt('SOURCE_VALIDATE_CONCURRENCY', 5, 20),
      timeoutMs: envPositiveInt('SOURCE_VALIDATE_TIMEOUT_MS', 8000, 60000),
    });
  console.log(`출처 URL 검증: ${sourceResult.accepted}/${sourceResult.candidates}건 채택`);
  if (options.send) await saveDeliveryPayload(dataDir, payload);
  return payload;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }

  const smtpConfig = (options.send || options.testEmail || options.checkSmtp)
    ? smtpConfigFromEnv()
    : null;
  if (options.checkSmtp) {
    const capabilities = await verifySmtp(smtpConfig);
    console.log(`SMTP 연결/TLS/인증 확인 완료: ${smtpConfig.host}:${smtpConfig.port}`);
    console.log(`서버 기능 응답: ${capabilities.length}줄`);
    return;
  }

  const dataDir = resolveDataDir(cliDir, process.env.LOCAL_DATA_DIR);
  const outputRoot = options.outDir
    || (process.env.LOCAL_OUTPUT_DIR
      ? path.resolve(cliDir, process.env.LOCAL_OUTPUT_DIR)
      : path.join(cliDir, 'output'));
  const recipientsPath = resolveRecipientsPath(cliDir, process.env.RECIPIENTS_PATH);
  const recipients = options.send
    ? await loadRecipients(
      recipientsPath,
      envPositiveInt('MAX_RECIPIENTS', 500, 5000),
    )
    : null;
  const deliveryKey = options.deliveryKey || createContext(new Date(), options.lookbackHours).toISO;

  const releaseLock = await acquireRunLock(dataDir);
  try {
    const payload = await collectPayload(options, dataDir, deliveryKey);
    const runDir = await saveRunOutput(payload, outputRoot);
    console.log(`로컬 결과: ${runDir}`);

    if (options.testEmail) {
      await sendTestNewsletter(
        payload,
        { email: options.testEmail, focus: '' },
        smtpConfig,
      );
      console.log(`시험 메일 발송 완료: ${options.testEmail}`);
    } else if (options.send) {
      const result = await deliverNewsletter(payload, recipients, {
        dataDir,
        smtpConfig,
        batchSize: process.env.MAIL_BATCH_SIZE,
      });
      await appendHistory(dataDir, payload, result.recipients);
      console.log(
        `SMTP 발송 완료: 수신자 ${result.recipients}명 / 이번 실행 ${result.sentThisRun}명`
        + ` / 메일 ${result.messagesThisRun}통`,
      );
    } else {
      console.log('메일을 발송하지 않았습니다. 실제 발송은 --send 옵션을 사용하세요.');
    }

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
