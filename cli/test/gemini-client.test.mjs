import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  callGeminiCli,
  stopAllGeminiProcesses,
} from '../src/gemini-client.mjs';

async function withFakeGemini(script, worker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-gemini-cli-'));
  const command = path.join(directory, 'fake-gemini.cmd');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'Path';
  const originalPath = process.env[pathKey];
  const originalBin = process.env.GEMINI_CLI_BIN;
  try {
    await fs.writeFile(command, script, 'utf8');
    process.env[pathKey] = `${directory};${originalPath || ''}`;
    process.env.GEMINI_CLI_BIN = 'fake-gemini';
    return await worker(directory);
  } finally {
    await stopAllGeminiProcesses();
    process.env[pathKey] = originalPath;
    if (originalBin === undefined) delete process.env.GEMINI_CLI_BIN;
    else process.env.GEMINI_CLI_BIN = originalBin;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('Windows headless Gemini JSON 응답을 읽는다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini('@echo off\r\necho {"response":"ok"}\r\n', async (directory) => {
    const result = await callGeminiCli('시험', { cwd: directory, timeoutMs: 5000 });
    assert.equal(result.response, 'ok');
  });
});

test('Windows 시간 초과 시 프로세스 트리를 종료한 뒤 TIMEOUT을 반환한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini([
    '@echo off',
    'ping 127.0.0.1 -n 20 >nul',
    'echo {"response":"late"}',
    '',
  ].join('\r\n'), async (directory) => {
    const startedAt = Date.now();
    await assert.rejects(
      () => callGeminiCli('시험', { cwd: directory, timeoutMs: 100 }),
      (error) => error.code === 'TIMEOUT',
    );
    assert.ok(Date.now() - startedAt < 8000);
  });
});

test('중단 신호는 Gemini 프로세스를 정리한 뒤 ABORTED를 반환한다', {
  skip: process.platform !== 'win32',
}, async () => {
  await withFakeGemini([
    '@echo off',
    'ping 127.0.0.1 -n 20 >nul',
    'echo {"response":"late"}',
    '',
  ].join('\r\n'), async (directory) => {
    const controller = new AbortController();
    const call = callGeminiCli('시험', {
      cwd: directory,
      timeoutMs: 10000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(call, (error) => error.code === 'ABORTED');
  });
});
