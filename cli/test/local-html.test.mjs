import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderNewsletterHtml } from '../src/email-renderer.mjs';
import {
  acquireOutputLock,
  saveHtmlOutput,
} from '../src/output-store.mjs';
import {
  buildMarkdownSummary,
  collectWithGeminiCli,
} from '../src/pipeline.mjs';
import {
  attachMockSources,
  validatePublicSourceUrl,
} from '../src/source-validator.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testDir, 'fixtures', 'responses.json');

async function withTempDir(worker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-html-test-'));
  try {
    return await worker(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('모의 payload를 인라인 CSS가 포함된 HTML로 렌더링한다', async () => {
  const payload = await collectWithGeminiCli({
    mockPath: fixture,
    now: new Date('2026-07-29T00:00:00.000Z'),
  });
  attachMockSources(payload);
  const html = renderNewsletterHtml(payload, 'export');
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /글로벌 통상 일일 모니터링/);
  assert.match(html, /style="/);
  assert.match(html, /PART 1/);
  assert.ok(html.indexOf('수출통제 동향') < html.indexOf('무역구제 동향'));
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script\b/i);
});

test('실행별 archive와 고정 latest HTML을 함께 저장한다', async () => {
  await withTempDir(async (directory) => {
    const payload = await collectWithGeminiCli({
      mockPath: fixture,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });
    attachMockSources(payload);
    const html = renderNewsletterHtml(payload);
    const release = await acquireOutputLock(directory);
    try {
      const saved = await saveHtmlOutput(payload, {
        outputRoot: directory,
        html,
        markdown: buildMarkdownSummary(payload),
      });
      assert.equal(await fs.readFile(saved.htmlPath, 'utf8'), html);
      assert.ok((await fs.stat(path.join(saved.runDir, 'result.json'))).isFile());
    } finally {
      await release();
    }
    await assert.rejects(
      () => fs.stat(path.join(directory, '.monitor.lock')),
      /ENOENT/,
    );
  });
});

test('공개 HTTPS 출처만 허용하고 사설 주소를 차단한다', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const fetchImpl = async (url) => {
    if (String(url).includes('/start')) {
      return {
        status: 302,
        headers: new Headers({ location: 'https://example.com/final' }),
        body: null,
      };
    }
    return { status: 200, headers: new Headers(), body: null };
  };
  const result = await validatePublicSourceUrl('https://example.com/start#tracking', {
    lookup,
    fetchImpl,
  });
  assert.equal(result, 'https://example.com/final');
  await assert.rejects(
    () => validatePublicSourceUrl('https://127.0.0.1/admin', { lookup, fetchImpl }),
    /HTTPS 공개 URL/,
  );
});
