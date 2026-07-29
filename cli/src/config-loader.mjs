import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(sourceDir, '..', '..');

function readRepoFile(name) {
  return fs.readFileSync(path.join(repoRoot, name), 'utf8');
}

function formatDate(dateValue, timeZone, pattern) {
  const date = new Date(dateValue);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const values = {
    yyyy: parts.year,
    MM: parts.month,
    dd: parts.day,
    HH: parts.hour,
    mm: parts.minute,
    E: String(parts.weekday || '').replace(/[()]/g, ''),
  };
  return pattern.replace(/yyyy|MM|dd|HH|mm|E/g, (token) => values[token]);
}

const sandbox = {
  Logger: { log() {} },
  console: { log() {}, warn() {}, error() {} },
  Utilities: { formatDate },
};
vm.createContext(sandbox);
vm.runInContext(readRepoFile('01_Config.gs'), sandbox, { filename: '01_Config.gs' });
vm.runInContext(readRepoFile('02_Main.gs'), sandbox, { filename: '02_Main.gs' });
vm.runInContext(readRepoFile('04_Sources.gs'), sandbox, { filename: '04_Sources.gs' });
vm.runInContext(readRepoFile('05_Insights.gs'), sandbox, { filename: '05_Insights.gs' });
vm.runInContext(readRepoFile('06_Email.gs'), sandbox, { filename: '06_Email.gs' });

if (!Array.isArray(sandbox.DOMAINS) || sandbox.DOMAINS.length !== 3) {
  throw new Error('01_Config.gs에서 DOMAINS 3개를 읽지 못했습니다.');
}

const unitCount = sandbox.DOMAINS.reduce((sum, domain) => sum + domain.units.length, 0);
if (unitCount !== 17) {
  throw new Error(`예상 수집 단위는 17개지만 ${unitCount}개를 읽었습니다.`);
}

export const domains = sandbox.DOMAINS;
export const buildInsightPrompt = sandbox.buildInsightPrompt;
export const parseInsightsWithRecovery = sandbox.parseInsightsWithRecovery;
export const makeEmptyInsights = sandbox.emptyInsights;
export const buildEmailHtml = sandbox.buildCombinedEmailHTML;
export const buildSubjectTriage = sandbox.buildSubjectTriage;
export const focusKeyFromText = sandbox.focusKeyFromText;
