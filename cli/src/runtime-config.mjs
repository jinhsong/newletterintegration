import fs from 'node:fs';

export const LOCAL_ENV_KEYS = new Set([
  'CLAUDE_CLI_ALLOWED_SHA256',
  'CLAUDE_CLI_BIN',
  'CLAUDE_CLI_MAX_TURNS',
  'CLAUDE_CLI_MODEL',
  'CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS',
  'CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN',
  'CLAUDE_CLI_RETRY_MAX',
  'CLAUDE_CLI_TIMEOUT_MS',
  'CLAUDE_RUN_TIMEOUT_MS',
  'GEMINI_CLI_BIN',
  'GEMINI_CLI_MODEL',
  'GEMINI_CLI_PREFLIGHT_TIMEOUT_MS',
  'GEMINI_CLI_RETRY_MAX',
  'GEMINI_CLI_TIMEOUT_MS',
  'GEMINI_RUN_TIMEOUT_MS',
  'CODEX_CLI_BIN',
  'CODEX_CLI_AUTH_MODE',
  'CODEX_CLI_MODEL',
  'CODEX_CLI_PREFLIGHT_TIMEOUT_MS',
  'CODEX_CLI_RETRY_MAX',
  'CODEX_CLI_TIMEOUT_MS',
  'CODEX_RUN_TIMEOUT_MS',
  'LOCAL_OUTPUT_FILE',
]);

export function loadEnvFile(filePath, targetEnv = process.env, warn = console.warn) {
  if (!fs.existsSync(filePath)) return;
  // 저장소 안의 링크가 외부 파일을 설정으로 주입하지 못하게 심볼릭 링크 자체를
  // 검사한다. statSync는 링크를 따라가므로 "일반 파일" 검사가 우회될 수 있다.
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size > 64 * 1024) {
    throw new Error('cli/.env는 64KB 이하의 일반 파일이어야 합니다.');
  }
  const source = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
    if (line.length > 4096) throw new Error('cli/.env 한 줄이 허용 길이를 초과했습니다.');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) {
      throw new Error(`cli/.env ${lineIndex + 1}번째 줄은 KEY=VALUE 형식이어야 합니다.`);
    }
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`cli/.env ${lineIndex + 1}번째 줄의 설정 이름이 올바르지 않습니다.`);
    }
    if (targetEnv[key] !== undefined) continue;
    if (!LOCAL_ENV_KEYS.has(key)) {
      warn(`cli/.env의 허용되지 않은 설정을 무시했습니다: ${key}`);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/[\u0000\r\n]/.test(value)) {
      throw new Error(`cli/.env ${lineIndex + 1}번째 줄의 설정 값에 허용되지 않은 제어 문자가 있습니다.`);
    }
    targetEnv[key] = value;
  }
}

function validateIntegerSetting(env, name, minimum, maximum) {
  const value = env[name];
  if (value === undefined) return;
  if (!/^\d+$/.test(String(value).trim())) {
    throw new Error(`${name}은 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name}은 ${minimum}~${maximum} 범위의 정수여야 합니다.`);
  }
}

export function validateRuntimeEnvironment(env = process.env, provider = 'all') {
  const normalizedProvider = String(provider || 'all').trim().toLowerCase();
  const validateClaude = normalizedProvider === 'all' || normalizedProvider === 'claude';
  const providerPrefixes = normalizedProvider === 'all'
    ? ['GEMINI', 'CODEX']
    : ({ gemini: ['GEMINI'], chatgpt: ['CODEX'], none: [] }[normalizedProvider] || []);
  if (!validateClaude && providerPrefixes.length === 0 && normalizedProvider !== 'none') {
    throw new Error('호출 모델은 claude, gemini, chatgpt 중 하나여야 합니다.');
  }
  if (validateClaude) {
    validateIntegerSetting(env, 'CLAUDE_CLI_PREFLIGHT_TIMEOUT_MS', 1, 300000);
    validateIntegerSetting(env, 'CLAUDE_CLI_RETRY_MAX', 1, 3);
    validateIntegerSetting(env, 'CLAUDE_CLI_TIMEOUT_MS', 1, 1800000);
    validateIntegerSetting(env, 'CLAUDE_RUN_TIMEOUT_MS', 1, 14400000);
    validateIntegerSetting(env, 'CLAUDE_CLI_MAX_TURNS', 1, 50);
  }
  for (const prefix of providerPrefixes) {
    validateIntegerSetting(env, `${prefix}_CLI_PREFLIGHT_TIMEOUT_MS`, 1, 300000);
    validateIntegerSetting(env, `${prefix}_CLI_RETRY_MAX`, 1, 3);
    validateIntegerSetting(env, `${prefix}_CLI_TIMEOUT_MS`, 1, 1800000);
    validateIntegerSetting(env, `${prefix}_RUN_TIMEOUT_MS`, 1, 14400000);
  }
  if ((normalizedProvider === 'all' || normalizedProvider === 'chatgpt')
    && !['', 'chatgpt', 'managed'].includes(String(env.CODEX_CLI_AUTH_MODE || '').trim().toLowerCase())) {
    throw new Error('CODEX_CLI_AUTH_MODE는 chatgpt 또는 managed여야 합니다.');
  }
  if (validateClaude && String(env.CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN || '').trim()
    && !['0', '1'].includes(String(env.CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN).trim())) {
    throw new Error('CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN은 0 또는 1이어야 합니다.');
  }
  if (validateClaude && String(env.CLAUDE_CLI_ALLOWED_SHA256 || '').trim()
    && !/^[0-9a-f]{64}$/i.test(String(env.CLAUDE_CLI_ALLOWED_SHA256).trim())) {
    throw new Error('CLAUDE_CLI_ALLOWED_SHA256는 64자리 SHA-256 16진수여야 합니다.');
  }
}
