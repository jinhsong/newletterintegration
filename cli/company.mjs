import process from 'node:process';
import { parseArgs } from './src/cli-args.mjs';
import { useSfu5ofProfile } from './src/config.mjs';

try {
  const args = process.argv.slice(2);
  const options = parseArgs(args);
  if (options.provider && options.provider !== 'claude') {
    throw new Error('이 실행기는 회사 Claude CLI를 사용합니다. --provider 옵션은 생략하세요.');
  }
  if (options.help) {
    console.log(`
회사 Claude CLI 통상 모니터링

  .\\run-monitoring.cmd
  .\\run-monitoring.cmd --lookback 24
  .\\run-monitoring.cmd --group "수출통제" --lookback 48
  .\\run-monitoring.cmd --category "export:US" --lookback 24
  .\\run-monitoring.cmd --depth fast --lookback 24
  .\\run-monitoring.cmd --out .\\보고서.html --no-open
  .\\run-monitoring.cmd --list-groups
  .\\run-monitoring.cmd --list-categories
  .\\run-monitoring.cmd --mock .\\cli\\test\\fixtures\\company-responses.json --no-open
  .\\run-monitoring.cmd --version

기존 통합 모니터링의 관세 9개·수출통제 5개·무역구제 3개 분류를 사용합니다.
회사 Claude CLI의 기존 인증을 사용하며 별도 LLM API 키를 요구하지 않습니다.
결과는 cli/output/monitoring.html에 저장하고 기본 브라우저로 엽니다.
실행 중 기간을 입력합니다. 빈 입력은 KST 월요일 72시간, 그 외 24시간입니다.
HTML 저장만 하려면 --no-open을 사용하세요.
부분 결과는 별도 파일로 보존하며 종료 코드 2입니다.
추가 옵션: --allow-partial-overwrite, --allow-parallel, --allow-network-output
`);
  } else {
    useSfu5ofProfile();
    if (!options.provider && !options.listCategories && !options.listGroups && !options.version) {
      process.argv.push('--provider', 'claude');
    }
    await import('./run.mjs');
  }
} catch (error) {
  console.error(`실행 실패: ${error.message}`);
  process.exitCode = 1;
}
