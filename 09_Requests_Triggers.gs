// ============================================================
//  이메일 요청 (온디맨드) + 트리거 설정
//
//  발송인 명단에 등록된 수신자가 발송 계정으로 제목에 REQUEST_KEYWORD
//  ('통상 요청')를 포함해 메일을 보내면, 통합 모니터링 결과를 회신한다.
//  - 한 주기에 들어온 인가 요청자 전원에게 1회 수집 결과를 일괄 회신
//  - 동향DB/옵시디안 저장은 생략 (정기 발송분과 중복 방지)
//  - 요청자별 일일 한도(ONDEMAND_DAILY_LIMIT)
// ============================================================

function checkEmailRequests() {
  var startMs = Date.now();
  try {
    var label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);

    var authorized = getAuthorizedEmails();
    if (Object.keys(authorized).length === 0) { Logger.log('[요청] 발송인 명단 비어 있음'); return; }

    var query = 'subject:"' + REQUEST_KEYWORD + '" -label:"' + PROCESSED_LABEL +
      '" in:inbox newer_than:' + Math.ceil(REQUEST_SEARCH_WINDOW_H / 24 + 1) + 'd';
    var threads = GmailApp.search(query, 0, 20);
    if (threads.length === 0) { Logger.log('[요청] 새 요청 없음'); return; }

    // 인가 요청자 수집 (미인가는 라벨만 부착)
    var requesterSet = {};
    var requestThreads = [];
    threads.forEach(function(thread) {
      var msgs = thread.getMessages();
      var msg = msgs[msgs.length - 1];
      var fromEmail = extractEmail(msg.getFrom()).toLowerCase();
      if ((msg.getSubject() || '').indexOf(REQUEST_KEYWORD) === -1) return;
      if (!authorized[fromEmail]) {
        Logger.log('[요청] 미인가 발신자 무시: ' + fromEmail);
        label.addToThread(thread); thread.markRead();
        return;
      }
      requesterSet[fromEmail] = true;
      requestThreads.push(thread);
    });

    var requesters = Object.keys(requesterSet);
    if (requesters.length === 0) return;

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_REQUEST_MS)) {
      Logger.log('[요청] 잠금 실패(정기 실행 중 추정) → 다음 폴링에서 처리'); return;
    }

    try {
      // 일일 한도 확인
      var allowed = [];
      requesters.forEach(function(em) {
        if (consumeOndemandQuota(em)) allowed.push(em);
        else {
          Logger.log('[요청] 한도 초과: ' + em);
          try {
            GmailApp.sendEmail(em, '[통상 모니터링] 일일 요청 한도 초과',
              '온디맨드 요청은 1인당 하루 최대 ' + ONDEMAND_DAILY_LIMIT + '회까지 처리됩니다. 내일 다시 요청해 주세요.');
          } catch (e) { /* 무시 */ }
        }
      });

      if (allowed.length > 0) {
        Logger.log('[요청] 처리 시작 → ' + allowed.join(', '));
        try {
          var result = runMonitoringCore({ skipSave: true, startMs: startMs });
          var dateStr = Utilities.formatDate(result.now, 'Asia/Seoul', 'yyyy년 MM월 dd일');
          var subject = '[글로벌 통상 모니터링] ' + dateStr + buildSubjectTriage(result.stats) + ' (요청)';
          allowed.forEach(function(em) {
            try {
              GmailApp.sendEmail(em, subject,
                '이 메일은 HTML 형식입니다. HTML 뷰어로 확인하세요.',
                { htmlBody: result.html, name: '통상 모니터링 시스템' });
              Logger.log('[요청] 발송 완료 → ' + em);
            } catch (se) { Logger.log('[요청] 발송 실패 (' + em + '): ' + se.message); }
          });
          logExecution('요청', allowed.length, result.stats, allowed.join(', '));
        } catch (runErr) {
          Logger.log('[요청] 실행 오류: ' + runErr.message);
          allowed.forEach(function(em) {
            try {
              GmailApp.sendEmail(em, '[통상 모니터링] 요청 처리 중 오류',
                '요청 처리 중 오류가 발생했습니다.\n오류: ' + runErr.message + '\n\n잠시 후 다시 요청해 주세요.');
            } catch (se) { /* 무시 */ }
          });
        }
      }

      // 처리 완료 표시
      requestThreads.forEach(function(t) { label.addToThread(t); t.markRead(); });
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('[요청] 치명적 오류: ' + e.message);
  }
}

/** 요청자별 일일 온디맨드 한도 차감. 한도 내면 true. */
function consumeOndemandQuota(email) {
  var props = PropertiesService.getScriptProperties();
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var state = null;
  try { state = JSON.parse(props.getProperty('ONDEMAND_COUNTS') || 'null'); } catch (e) { /* 재생성 */ }
  if (!state || state.date !== today) state = { date: today, counts: {} };
  var used = state.counts[email] || 0;
  if (used >= ONDEMAND_DAILY_LIMIT) return false;
  state.counts[email] = used + 1;
  props.setProperty('ONDEMAND_COUNTS', JSON.stringify(state));
  return true;
}

/** "이름 <a@b.com>" 또는 "a@b.com" → 이메일만 추출 */
function extractEmail(raw) {
  var m = (raw || '').toString().match(/<([^>]+)>/);
  return (m ? m[1] : raw).toString().trim();
}


// ============================================================
//  트리거 설정 (최초 1회)
// ============================================================

/** 평일(월~금) 09시 정기 + 5분 요청 폴링 등록 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runDailyMonitoring' || fn === 'checkEmailRequests') ScriptApp.deleteTrigger(t);
  });

  [ScriptApp.WeekDay.MONDAY, ScriptApp.WeekDay.TUESDAY, ScriptApp.WeekDay.WEDNESDAY,
   ScriptApp.WeekDay.THURSDAY, ScriptApp.WeekDay.FRIDAY].forEach(function(wd) {
    ScriptApp.newTrigger('runDailyMonitoring').timeBased().onWeekDay(wd).atHour(9)
      .inTimezone('Asia/Seoul').create();
  });

  ScriptApp.newTrigger('checkEmailRequests').timeBased().everyMinutes(5).create();
  Logger.log('트리거 등록: 평일 09시 정기(5개) + 5분 요청 폴링');
}

function listTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  Logger.log('=== 트리거 ' + ts.length + '개 ===');
  ts.forEach(function(t, i) { Logger.log('[' + (i + 1) + '] ' + t.getHandlerFunction()); });
}

/** 이메일 요청 기능 수동 테스트 */
function testEmailRequestCheck() { checkEmailRequests(); }
