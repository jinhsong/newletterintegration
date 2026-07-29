import {
  buildEmailHtml,
  buildSubjectTriage,
} from './config-loader.mjs';

const KST = 'Asia/Seoul';

function kstDateLabel(dateValue) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ko-KR', {
      timeZone: KST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(dateValue))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}년 ${parts.month}월 ${parts.day}일`;
}

export function buildNewsletterSubject(payload) {
  return `[글로벌 통상 모니터링] ${kstDateLabel(payload.nowISO)}${buildSubjectTriage(payload.stats)}`;
}

export function renderNewsletterHtml(payload, focus = '') {
  return buildEmailHtml(
    payload.data,
    payload.insights,
    new Date(payload.nowISO),
    new Date(payload.fromISO),
    payload.stats,
    payload.failedUnits,
    focus,
  );
}

export function newsletterTextFallback(payload) {
  return [
    '글로벌 통상 일일 모니터링',
    `발행일: ${kstDateLabel(payload.nowISO)}`,
    `총 ${payload.stats.total}건 / 중요도 상 ${payload.stats.high}건`,
    '',
    '이 메일은 HTML 형식입니다. 자세한 내용은 HTML 보기를 지원하는 메일 프로그램에서 확인하세요.',
  ].join('\r\n');
}
