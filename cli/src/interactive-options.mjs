import { createInterface } from 'node:readline/promises';
import process from 'node:process';
import { DEFAULT_PROVIDER_KEY } from './provider-registry.mjs';

const PROVIDER_ALIASES = new Map([
  ['', DEFAULT_PROVIDER_KEY],
  ['1', 'claude'],
  ['claude', 'claude'],
  ['클로드', 'claude'],
  ['2', 'gemini'],
  ['gemini', 'gemini'],
  ['제미나이', 'gemini'],
  ['3', 'chatgpt'],
  ['chatgpt', 'chatgpt'],
  ['chat gpt', 'chatgpt'],
  ['codex', 'chatgpt'],
  ['챗gpt', 'chatgpt'],
  ['챗지피티', 'chatgpt'],
]);

export function normalizeInteractiveProvider(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('en-US');
  const provider = PROVIDER_ALIASES.get(normalized);
  if (!provider) throw new Error('1, 2, 3 또는 claude, gemini, chatgpt 중 하나를 입력하세요.');
  return provider;
}

export function normalizeInteractiveLookback(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) throw new Error('모니터링 기간은 1~168 사이의 정수 시간으로 입력하세요.');
  const hours = Number(normalized);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
    throw new Error('모니터링 기간은 1~168시간 범위여야 합니다.');
  }
  return hours;
}

export function shouldPromptForOptions(options, input = process.stdin, output = process.stdout) {
  if (options.mockPath) return false;
  if (options.provider && options.lookbackHours !== undefined) return false;
  return input.isTTY === true && output.isTTY === true;
}

async function askUntilValid(question, parse, writeError) {
  for (;;) {
    const answer = await question();
    try {
      return parse(answer);
    } catch (error) {
      writeError(`입력 오류: ${error.message}\n`);
    }
  }
}

export async function completeInteractiveOptions(options, dependencies = {}) {
  const input = dependencies.input || process.stdin;
  const output = dependencies.output || process.stdout;
  const result = { ...options };
  if (!shouldPromptForOptions(result, input, output)) {
    result.provider ||= DEFAULT_PROVIDER_KEY;
    return result;
  }

  const readline = dependencies.readline || createInterface({ input, output, terminal: true });
  const ownsReadline = !dependencies.readline;
  const writeError = dependencies.writeError || ((message) => output.write(message));
  try {
    if (!result.provider) {
      output.write([
        '',
        '호출 모델을 선택하세요.',
        '  1. Claude (기본값)',
        '  2. Gemini',
        '  3. ChatGPT (Codex CLI)',
      ].join('\n') + '\n');
      result.provider = await askUntilValid(
        () => readline.question('선택 [Enter=1]: '),
        normalizeInteractiveProvider,
        writeError,
      );
    }
    if (result.lookbackHours === undefined) {
      output.write([
        '',
        '모니터링 기간을 시간 단위로 입력하세요. (1~168시간)',
        '아무 값도 입력하지 않으면 월요일은 72시간, 그 외 요일은 24시간입니다.',
      ].join('\n') + '\n');
      result.lookbackHours = await askUntilValid(
        () => readline.question('기간 [Enter=요일 기본값]: '),
        normalizeInteractiveLookback,
        writeError,
      );
    }
    return result;
  } catch (error) {
    const wrapped = new Error(`사용자 입력을 완료하지 못했습니다: ${error.message}`);
    wrapped.code = error?.code === 'ABORT_ERR' ? 'ABORTED' : 'INPUT';
    throw wrapped;
  } finally {
    if (ownsReadline) readline.close();
  }
}
