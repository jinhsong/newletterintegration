import { spawn } from 'node:child_process';
import process from 'node:process';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeCliToken(value, label) {
  const token = String(value || '').trim();
  if (!token || !/^[a-zA-Z0-9._:/\\-]+$/.test(token)) {
    throw new Error(`${label} 값에 허용되지 않은 문자가 있습니다.`);
  }
  return token;
}

function launchSpec() {
  const configuredBin = process.env.GEMINI_CLI_BIN || 'gemini';
  const model = String(process.env.GEMINI_CLI_MODEL || '').trim();
  if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) {
    throw new Error('GEMINI_CLI_MODEL 값에 허용되지 않은 문자가 있습니다.');
  }

  const fixedArgs = ['--output-format', 'json'];
  if (model) fixedArgs.push('--model', model);

  if (process.platform !== 'win32') {
    return { command: configuredBin, args: fixedArgs, shell: false };
  }

  // npm 전역 설치의 gemini.cmd는 CreateProcess로 직접 실행할 수 없다. 프롬프트는
  // 명령행에 넣지 않고 stdin으로 전달해 뉴스 텍스트의 셸 메타문자 주입을 차단한다.
  const bin = safeCliToken(configuredBin, 'GEMINI_CLI_BIN');
  const commandLine = [bin, ...fixedArgs.map((arg) => safeCliToken(arg, 'CLI 인자'))].join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    shell: false,
  };
}

function enterpriseEnvironment() {
  const env = { ...process.env, NO_COLOR: '1' };
  // 우연히 설정된 AI Studio/Vertex 키로 과금되는 것을 막고 사내 OAuth만 사용한다.
  // 빈 값을 미리 정의해 Gemini CLI의 상위/사용자 .env가 키를 다시 주입하지 못하게 한다.
  env.GEMINI_API_KEY = '';
  env.GOOGLE_API_KEY = '';
  env.GOOGLE_GENAI_USE_VERTEXAI = 'false';
  if (!env.GOOGLE_CLOUD_PROJECT && !env.GOOGLE_CLOUD_PROJECT_ID) {
    throw new Error('GOOGLE_CLOUD_PROJECT가 없습니다. 사내 Gemini 프로젝트 ID를 설정하세요.');
  }
  return env;
}

export async function callGeminiCli(prompt, options = {}) {
  const timeoutMs = positiveInt(
    options.timeoutMs || process.env.GEMINI_CLI_TIMEOUT_MS,
    240000,
  );
  const spec = launchSpec();

  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: enterpriseEnvironment(),
      shell: spec.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`Gemini CLI 시간 초과 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_CAPTURE_BYTES) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_CAPTURE_BYTES) child.kill();
    });
    child.stdin.on('error', (error) => {
      // 인증 오류 등으로 프로세스가 먼저 끝나면 EPIPE가 날 수 있다. close 이벤트의
      // 종료 코드와 stderr를 최종 오류로 사용하므로 여기서는 기록만 한다.
      stderr += `\nstdin: ${error.message}`;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Gemini CLI 종료 코드 ${code}: ${stderr.trim().slice(0, 2000)}`));
        return;
      }
      let envelope;
      try {
        envelope = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`Gemini CLI JSON envelope 파싱 실패: ${stdout.trim().slice(0, 500)}`));
        return;
      }
      if (envelope.error) {
        reject(new Error(`Gemini CLI 오류: ${envelope.error.message || JSON.stringify(envelope.error)}`));
        return;
      }
      if (typeof envelope.response !== 'string') {
        reject(new Error('Gemini CLI 응답에 response 문자열이 없습니다.'));
        return;
      }
      resolve({ response: envelope.response, stats: envelope.stats || null });
    });

    // 공식 headless 파이프 입력 방식. 프롬프트를 명령행 인자로 노출하지 않는다.
    child.stdin.end(prompt, 'utf8');
  });
}

export function cliRetryMax() {
  return positiveInt(process.env.GEMINI_CLI_RETRY_MAX, 3);
}

export function cliConcurrency() {
  return positiveInt(process.env.GEMINI_CLI_CONCURRENCY, 3);
}
