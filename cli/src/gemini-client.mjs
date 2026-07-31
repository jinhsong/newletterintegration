import { spawn } from 'node:child_process';
import process from 'node:process';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const activeChildren = new Set();
const stoppingChildren = new WeakMap();

function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function safeToken(value, label) {
  const token = String(value || '').trim();
  if (!token || !/^[a-zA-Z0-9._:/\\-]+$/.test(token)) {
    throw new GeminiCliError('CONFIG', `${label} 값에 허용되지 않은 문자가 있습니다.`);
  }
  return token;
}

export class GeminiCliError extends Error {
  constructor(code, message, details = '') {
    super(message);
    this.name = 'GeminiCliError';
    this.code = code;
    this.details = details;
  }
}

function classifyError(message, exitCode) {
  const text = String(message || '');
  if (/not recognized|command not found|ENOENT|찾을 수 없/i.test(text)) return 'CLI_NOT_FOUND';
  if (/GOOGLE_CLOUD_PROJECT|project id|project.*required|프로젝트/i.test(text)) return 'PROJECT';
  if (/oauth|login|log in|sign in|authentication|credentials|unauthorized|\b401\b/i.test(text)) return 'AUTH';
  if (/trusted folder|untrusted|workspace trust/i.test(text)) return 'TRUST';
  if (/policy|not allowed|permission denied|forbidden|disabled|blocked|\b403\b/i.test(text)) return 'POLICY';
  if (/\b429\b|rate.?limit|quota|resource.?exhausted/i.test(text)) return 'RATE_LIMIT';
  if (/\b50[0234]\b|service unavailable|temporarily unavailable|internal server error|backend error/i.test(text)) return 'SERVICE';
  if (/turn limit|maximum.*turn|exit code 53/i.test(text) || exitCode === 53) return 'TURN_LIMIT';
  if (/timeout|timed out|시간 초과|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(text)) return 'TIMEOUT';
  return 'CLI_EXIT';
}

function launchSpec() {
  const configuredBin = process.env.GEMINI_CLI_BIN || 'gemini';
  const model = String(process.env.GEMINI_CLI_MODEL || '').trim();
  const fixedArgs = ['--output-format', 'json'];
  if (model) fixedArgs.push('--model', safeToken(model, 'GEMINI_CLI_MODEL'));

  if (process.platform !== 'win32') {
    return { command: configuredBin, args: fixedArgs };
  }

  const bin = safeToken(configuredBin, 'GEMINI_CLI_BIN');
  const commandLine = [bin, ...fixedArgs.map((arg) => safeToken(arg, 'CLI 인자'))].join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
  };
}

function enterpriseEnvironment() {
  const env = { ...process.env, NO_COLOR: '1' };
  // 개인 API 키로 우회하지 않고 회사에서 관리하는 Gemini CLI 로그인 설정을 사용한다.
  env.GEMINI_API_KEY = '';
  env.GOOGLE_API_KEY = '';
  return env;
}

function waitForChildClose(child, waitMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (closed) => {
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), waitMs);
    child.once('close', onClose);
  });
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, details: 'taskkill 실행 실패' });
      return;
    }
    let finished = false;
    let details = '';
    killer.stdout?.setEncoding('utf8');
    killer.stdout?.on('data', (chunk) => { details += chunk; });
    killer.stderr?.setEncoding('utf8');
    killer.stderr?.on('data', (chunk) => { details += chunk; });
    const done = (code = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, details: details.trim().slice(0, 500) });
    };
    const timer = setTimeout(() => {
      killer.kill();
      done();
    }, 5000);
    killer.once('error', (error) => {
      details = error.message;
      done(null);
    });
    killer.once('close', done);
  });
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const existing = stoppingChildren.get(child);
  if (existing) return existing;

  const stopping = (async () => {
    if (process.platform === 'win32' && child.pid) {
      const killed = await runTaskkill(child.pid);
      if (killed.code !== 0 && child.exitCode === null && child.signalCode === null) {
        console.warn(`Gemini 프로세스 트리 종료 경고: ${killed.details || `taskkill 종료 코드 ${killed.code}`}`);
      }
    } else {
      child.kill('SIGTERM');
    }
    const closed = await waitForChildClose(child, 7000);
    if (!closed && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForChildClose(child, 1000);
    }
  })();
  stoppingChildren.set(child, stopping);
  return stopping;
}

export async function stopAllGeminiProcesses() {
  await Promise.allSettled([...activeChildren].map((child) => stopProcessTree(child)));
}

export function isRetryableGeminiError(error) {
  return ['TIMEOUT', 'RATE_LIMIT', 'SERVICE'].includes(error?.code);
}

export function retryMax() {
  return positiveInt(process.env.GEMINI_CLI_RETRY_MAX, 2, 3);
}

export function timeoutMs() {
  return positiveInt(process.env.GEMINI_CLI_TIMEOUT_MS, 600000, 1800000);
}

export async function callGeminiCli(prompt, options = {}) {
  const timeout = positiveInt(options.timeoutMs, timeoutMs(), 1800000);
  const spec = launchSpec();

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
      return;
    }

    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: options.cwd,
        env: enterpriseEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new GeminiCliError('CLI_NOT_FOUND', `Gemini CLI를 실행하지 못했습니다: ${error.message}`));
      return;
    }

    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forcedError = null;
    let timer;
    let heartbeat;
    const startedAt = Date.now();

    const finish = (worker) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      options.signal?.removeEventListener('abort', onAbort);
      activeChildren.delete(child);
      worker();
    };

    const forceStop = async (error) => {
      if (settled || forcedError) return;
      forcedError = error;
      await stopProcessTree(child);
      finish(() => reject(error));
    };

    const onAbort = () => {
      void forceStop(new GeminiCliError('ABORTED', '사용자가 실행을 중단했습니다.'));
    };

    timer = setTimeout(() => {
      void forceStop(new GeminiCliError(
        'TIMEOUT',
        `Gemini 응답이 ${Math.round(timeout / 60000)}분 안에 끝나지 않았습니다.`,
      ));
    }, timeout);

    heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  ... Gemini 조사 중 (${seconds}초 경과)`);
    }, 20000);
    heartbeat.unref();

    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_CAPTURE_BYTES) {
        void forceStop(new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 출력이 허용 크기를 초과했습니다.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > MAX_CAPTURE_BYTES) {
        void forceStop(new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 오류 출력이 허용 크기를 초과했습니다.'));
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (forcedError) return;
      const code = classifyError(error.message);
      finish(() => reject(new GeminiCliError(code, `Gemini CLI 실행 오류: ${error.message}`)));
    });
    child.on('close', (exitCode) => {
      if (forcedError) return;
      finish(() => {
        if (exitCode !== 0) {
          const detail = stderr.trim().slice(0, 3000) || stdout.trim().slice(0, 1000);
          const code = classifyError(detail, exitCode);
          reject(new GeminiCliError(code, `Gemini CLI 오류(${code})`, detail));
          return;
        }
        let envelope;
        try {
          envelope = JSON.parse(stdout.trim());
        } catch {
          reject(new GeminiCliError(
            'BAD_OUTPUT',
            'Gemini CLI의 JSON 응답을 읽지 못했습니다.',
            stdout.trim().slice(0, 1000),
          ));
          return;
        }
        if (envelope.error) {
          const detail = envelope.error.message || JSON.stringify(envelope.error);
          reject(new GeminiCliError(classifyError(detail), 'Gemini CLI가 오류를 반환했습니다.', detail));
          return;
        }
        if (typeof envelope.response !== 'string') {
          reject(new GeminiCliError('BAD_OUTPUT', 'Gemini CLI 응답에 response 문자열이 없습니다.'));
          return;
        }
        resolve({ response: envelope.response, stats: envelope.stats || null });
      });
    });

    child.stdin.end(prompt, 'utf8');
  });
}
