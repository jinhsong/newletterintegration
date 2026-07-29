import fs from 'node:fs/promises';
import path from 'node:path';
import { focusKeyFromText } from './config-loader.mjs';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error('수신자 CSV의 따옴표가 닫히지 않았습니다.');
  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((item) => item.some((value) => value.trim()));
}

function headerIndex(headers, names) {
  return headers.findIndex((header) => names.includes(header.trim().toLowerCase()));
}

function validEmail(value) {
  return /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/.test(value);
}

function enabled(value) {
  return ['y', 'yes', 'true', '1', '사용', '발송'].includes(String(value || '').trim().toLowerCase());
}

export async function loadRecipients(filePath, maxRecipients = 500) {
  const text = await fs.readFile(filePath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      throw new Error(
        `수신자 파일이 없습니다: ${filePath}\n`
        + 'config/recipients.example.csv를 config/recipients.csv로 복사하세요.',
      );
    }
    throw error;
  });
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('수신자 CSV에 헤더와 한 명 이상의 수신자가 필요합니다.');

  const headers = rows[0].map((value) => value.trim().toLowerCase());
  const indexes = {
    name: headerIndex(headers, ['name', '이름']),
    email: headerIndex(headers, ['email', '이메일']),
    enabled: headerIndex(headers, ['enabled', '발송여부']),
    focus: headerIndex(headers, ['focus', '관심영역']),
  };
  if (indexes.email < 0 || indexes.enabled < 0) {
    throw new Error('수신자 CSV에는 email(이메일), enabled(발송여부) 열이 필요합니다.');
  }

  const recipients = [];
  const seen = new Set();
  for (const [offset, row] of rows.slice(1).entries()) {
    if (!enabled(row[indexes.enabled])) continue;
    const email = String(row[indexes.email] || '').trim();
    if (!validEmail(email)) {
      throw new Error(`수신자 CSV ${offset + 2}행 이메일 형식이 잘못됐습니다: ${email || '(빈 값)'}`);
    }
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push({
      name: indexes.name >= 0 ? String(row[indexes.name] || '').trim() : '',
      email,
      focus: indexes.focus >= 0 ? focusKeyFromText(row[indexes.focus]) : '',
    });
  }

  if (recipients.length === 0) {
    throw new Error('enabled=Y인 유효한 수신자가 없습니다. 안전을 위해 빈 값은 발송 대상이 아닙니다.');
  }
  if (recipients.length > maxRecipients) {
    throw new Error(`수신자가 안전 한도 ${maxRecipients}명을 초과했습니다: ${recipients.length}명`);
  }
  return recipients;
}

export function resolveRecipientsPath(cliDir, configuredPath) {
  return configuredPath
    ? path.resolve(cliDir, configuredPath)
    : path.join(cliDir, 'config', 'recipients.csv');
}

export function isValidEmail(value) {
  return validEmail(String(value || '').trim());
}
