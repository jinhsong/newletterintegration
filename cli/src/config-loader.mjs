import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(sourceDir, '..', '..');

function readRepoFile(name) {
  return fs.readFileSync(path.join(repoRoot, name), 'utf8');
}

const sandbox = {
  Logger: { log() {} },
  console: { log() {}, warn() {}, error() {} },
};
vm.createContext(sandbox);
vm.runInContext(readRepoFile('01_Config.gs'), sandbox, { filename: '01_Config.gs' });
vm.runInContext(readRepoFile('05_Insights.gs'), sandbox, { filename: '05_Insights.gs' });

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
