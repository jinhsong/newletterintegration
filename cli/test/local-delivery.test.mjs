import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sendTestNewsletter } from '../src/delivery.mjs';
import { renderNewsletterHtml } from '../src/email-renderer.mjs';
import {
  appendHistory,
  loadHistoryTitles,
} from '../src/local-store.mjs';
import { collectWithGeminiCli } from '../src/pipeline.mjs';
import { loadRecipients } from '../src/recipients.mjs';
import {
  smtpConfigFromEnv,
  verifySmtp,
} from '../src/smtp-client.mjs';
import { validatePublicSourceUrl } from '../src/source-validator.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(testDir, 'fixtures', 'responses.json');

async function withTempDir(worker) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trade-monitor-test-'));
  try {
    return await worker(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function fakeSmtpServer() {
  const messages = [];
  const commands = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake-smtp ESMTP\r\n');
    let buffer = '';
    let dataMode = false;
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        if (dataMode) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          dataMode = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        if (line.startsWith('EHLO ')) socket.write('250-fake-smtp\r\n250 SIZE 5242880\r\n');
        else if (line === 'NOOP') socket.write('250 2.0.0 ok\r\n');
        else if (line.startsWith('MAIL FROM:')) socket.write('250 2.1.0 ok\r\n');
        else if (line.startsWith('RCPT TO:')) socket.write('250 2.1.5 ok\r\n');
        else if (line === 'DATA') {
          dataMode = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else {
          socket.write('500 unsupported\r\n');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    messages,
    commands,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('CSV는 enabled=Y만 읽고 관심영역과 중복을 정규화한다', async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, 'recipients.csv');
    await fs.writeFile(filePath, [
      'name,email,enabled,focus',
      '관세담당,customs@company.com,Y,관세',
      '중복,customs@company.com,Y,수출통제',
      '제외,off@company.com,N,무역구제',
      '',
    ].join('\n'), 'utf8');
    const recipients = await loadRecipients(filePath);
    assert.deepEqual(recipients, [{
      name: '관세담당',
      email: 'customs@company.com',
      focus: 'customs',
    }]);
  });
});

test('모의 payload로 로컬 HTML과 최근 발송 이력을 만든다', async () => {
  await withTempDir(async (directory) => {
    const now = new Date('2026-07-29T00:00:00.000Z');
    const payload = await collectWithGeminiCli({ mockPath: fixture, now });
    const html = renderNewsletterHtml(payload, 'export');
    assert.match(html, /글로벌 통상 일일 모니터링/);
    assert.match(html, /PART 1/);
    assert.match(html, /수출통제 동향/);

    await appendHistory(directory, payload, 1);
    const history = await loadHistoryTitles(directory, 7);
    assert.ok(history.customs.length > 0);
    assert.ok(history.exportControl.length > 0);
  });
});

test('공개 HTTPS 출처만 검증하고 안전한 리다이렉트를 따른다', async () => {
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

test('사내 평문 IP 릴레이 모드에서 SMTP 점검과 시험 메일을 수행한다', async () => {
  const server = await fakeSmtpServer();
  try {
    const config = smtpConfigFromEnv({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(server.port),
      SMTP_SECURE: 'false',
      SMTP_REQUIRE_TLS: 'false',
      SMTP_ALLOW_INSECURE: 'true',
      SMTP_AUTH: 'none',
      MAIL_FROM: 'monitor@company.com',
      MAIL_FROM_NAME: '통상 모니터링',
    });
    await verifySmtp(config);

    const payload = await collectWithGeminiCli({
      mockPath: fixture,
      now: new Date('2026-07-29T00:00:00.000Z'),
    });
    await sendTestNewsletter(payload, {
      email: 'tester@company.com',
      focus: 'customs',
    }, config);

    assert.equal(server.messages.length, 1);
    assert.ok(server.commands.includes('RCPT TO:<tester@company.com>'));
    assert.doesNotMatch(server.messages[0], /^Bcc:/mi);
    assert.match(server.messages[0], /^Subject: =\?UTF-8\?B\?/mi);
    assert.match(server.messages[0], /Content-Type: text\/html; charset=UTF-8/i);
  } finally {
    await server.close();
  }
});
