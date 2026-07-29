import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30000;

function booleanValue(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`불리언 설정값이 잘못됐습니다: ${value}`);
}

function positiveInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`양의 정수가 필요합니다: ${value}`);
  return parsed;
}

function sanitizeHeader(value, label) {
  const output = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!output) throw new Error(`${label} 값이 비어 있습니다.`);
  return output;
}

function validMailbox(value) {
  return /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/.test(String(value || ''));
}

function mailbox(value, label) {
  const output = String(value || '').trim();
  if (!validMailbox(output)) throw new Error(`${label} 이메일 형식이 잘못됐습니다: ${output || '(빈 값)'}`);
  return output;
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value, '메일 헤더');
  return /^[\x20-\x7E]+$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function base64Lines(value) {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') || '';
}

function buildMessage(mail) {
  const from = mailbox(mail.from, 'MAIL_FROM');
  const recipients = [...new Set([...(mail.to || []), ...(mail.bcc || [])].map((item) => mailbox(item, '수신자')))];
  if (recipients.length === 0) throw new Error('SMTP 수신자가 없습니다.');
  const domain = from.split('@')[1];
  const boundary = `=_trade_monitor_${randomUUID().replaceAll('-', '')}`;
  const fromHeader = mail.fromName
    ? `${encodeHeader(mail.fromName)} <${from}>`
    : from;
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    `From: ${fromHeader}`,
    `To: ${mail.to?.length ? mail.to.map((item) => mailbox(item, 'To')).join(', ') : 'undisclosed-recipients:;'}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (mail.replyTo) headers.push(`Reply-To: ${mailbox(mail.replyTo, 'MAIL_REPLY_TO')}`);
  headers.push(
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text || ''),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.html || ''),
    `--${boundary}--`,
    '',
  );
  const data = headers.join('\r\n').replace(/^\./gm, '..');
  return { from, recipients, data };
}

class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.socket.setEncoding('utf8');
  }

  async readChunk() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('SMTP 응답 시간 초과'));
      }, this.timeoutMs);
      const onData = (chunk) => {
        cleanup();
        resolve(chunk);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('SMTP 서버가 연결을 종료했습니다.'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
      };
      this.socket.once('data', onData);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
    });
  }

  async readResponse() {
    const lines = [];
    let responseCode = null;
    while (true) {
      const end = this.buffer.indexOf('\r\n');
      if (end < 0) {
        this.buffer += await this.readChunk();
        continue;
      }
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])/);
      if (!match) continue;
      if (responseCode === null) responseCode = Number(match[1]);
      if (Number(match[1]) === responseCode && match[2] === ' ') {
        return { code: responseCode, lines };
      }
    }
  }

  async command(command, expectedCodes, safeLabel) {
    this.socket.write(`${command}\r\n`, 'utf8');
    const response = await this.readResponse();
    if (!expectedCodes.includes(response.code)) {
      const label = safeLabel || (/^[A-Z]+(?:\s|$)/.exec(command)?.[0].trim()) || '명령';
      throw new Error(`SMTP ${label} 실패: ${response.lines.join(' | ')}`);
    }
    return response;
  }

  async close() {
    if (!this.socket.destroyed) {
      await this.command('QUIT', [221]).catch(() => {});
      this.socket.end();
    }
  }
}

async function connectSocket(config) {
  return new Promise((resolve, reject) => {
    const options = {
      host: config.host,
      port: config.port,
      servername: config.tlsServername || config.host,
      rejectUnauthorized: true,
    };
    const socket = config.secure
      ? tls.connect(options)
      : net.connect({ host: config.host, port: config.port });
    const event = config.secure ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP 연결 시간 초과'));
    }, config.timeoutMs);
    socket.once(event, () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function upgradeTls(session, config) {
  const plainSocket = session.socket;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: plainSocket,
      servername: config.tlsServername || config.host,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP STARTTLS 연결 시간 초과'));
    }, config.timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(new SmtpSession(socket, config.timeoutMs));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function authenticate(session, config) {
  if (config.auth === 'none') return;
  if (!config.secureConnection) {
    throw new Error('SMTP 계정 인증은 TLS 연결에서만 허용됩니다.');
  }
  if (config.auth === 'plain') {
    const token = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64');
    await session.command(`AUTH PLAIN ${token}`, [235]);
    return;
  }
  if (config.auth === 'login') {
    await session.command('AUTH LOGIN', [334]);
    await session.command(Buffer.from(config.user, 'utf8').toString('base64'), [334], 'AUTH 사용자');
    await session.command(Buffer.from(config.password, 'utf8').toString('base64'), [235], 'AUTH 비밀번호');
    return;
  }
  throw new Error(`지원하지 않는 SMTP_AUTH: ${config.auth}`);
}

async function openSession(inputConfig) {
  const config = { ...inputConfig, secureConnection: inputConfig.secure };
  let session = new SmtpSession(await connectSocket(config), config.timeoutMs);
  const greeting = await session.readResponse();
  if (greeting.code !== 220) throw new Error(`SMTP 인사 실패: ${greeting.lines.join(' | ')}`);
  let ehlo = await session.command(`EHLO ${config.ehloName}`, [250]);

  if (!config.secure) {
    const supportsStartTls = ehlo.lines.some((line) => /\bSTARTTLS\b/i.test(line));
    if (supportsStartTls) {
      await session.command('STARTTLS', [220]);
      session = await upgradeTls(session, config);
      config.secureConnection = true;
      ehlo = await session.command(`EHLO ${config.ehloName}`, [250]);
    } else if (config.requireTls || !config.allowInsecure) {
      await session.close();
      throw new Error('SMTP 서버가 STARTTLS를 제공하지 않습니다. 평문 릴레이는 명시적으로 허용해야 합니다.');
    }
  }
  await authenticate(session, config);
  return { session, config, capabilities: ehlo.lines };
}

export function smtpConfigFromEnv(env = globalThis.process?.env || {}) {
  const secure = booleanValue(env.SMTP_SECURE, false);
  const auth = String(env.SMTP_AUTH || 'none').trim().toLowerCase();
  const config = {
    host: String(env.SMTP_HOST || '').trim(),
    port: positiveInt(env.SMTP_PORT, secure ? 465 : 587),
    secure,
    requireTls: booleanValue(env.SMTP_REQUIRE_TLS, true),
    allowInsecure: booleanValue(env.SMTP_ALLOW_INSECURE, false),
    auth,
    user: String(env.SMTP_USER || ''),
    password: String(env.SMTP_PASSWORD || ''),
    timeoutMs: positiveInt(env.SMTP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    ehloName: String(env.SMTP_EHLO_NAME || os.hostname()).replace(/[^a-zA-Z0-9.-]/g, '-') || 'localhost',
    tlsServername: String(env.SMTP_TLS_SERVERNAME || '').trim(),
    from: String(env.MAIL_FROM || '').trim(),
    fromName: String(env.MAIL_FROM_NAME || '통상 모니터링 시스템').trim(),
    replyTo: String(env.MAIL_REPLY_TO || '').trim(),
  };
  if (!config.host || /[\s\r\n]/.test(config.host)) throw new Error('SMTP_HOST를 설정하세요.');
  if (!['none', 'plain', 'login'].includes(config.auth)) {
    throw new Error('SMTP_AUTH는 none, plain, login 중 하나여야 합니다.');
  }
  if (config.auth !== 'none' && (!config.user || !config.password)) {
    throw new Error('SMTP 인증을 사용하려면 SMTP_USER와 SMTP_PASSWORD가 필요합니다.');
  }
  mailbox(config.from, 'MAIL_FROM');
  if (config.replyTo) mailbox(config.replyTo, 'MAIL_REPLY_TO');
  if (!config.secure && !config.requireTls && !config.allowInsecure) {
    throw new Error('TLS를 사용하지 않으려면 SMTP_ALLOW_INSECURE=true를 명시해야 합니다.');
  }
  return config;
}

export async function verifySmtp(config) {
  const { session, capabilities } = await openSession(config);
  try {
    await session.command('NOOP', [250]);
    return capabilities;
  } finally {
    await session.close();
  }
}

export async function sendSmtpMail(config, mail) {
  const message = buildMessage({
    ...mail,
    from: config.from,
    fromName: config.fromName,
    replyTo: config.replyTo,
  });
  const { session } = await openSession(config);
  try {
    await session.command(`MAIL FROM:<${message.from}>`, [250]);
    for (const recipient of message.recipients) {
      await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await session.command('DATA', [354]);
    session.socket.write(`${message.data}\r\n.\r\n`, 'utf8');
    const accepted = await session.readResponse();
    if (accepted.code !== 250) {
      throw new Error(`SMTP DATA 실패: ${accepted.lines.join(' | ')}`);
    }
    return { accepted: message.recipients };
  } finally {
    await session.close();
  }
}
