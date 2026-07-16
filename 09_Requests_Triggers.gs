// ============================================================
//  이메일 요청 (온디맨드) + 트리거 설정
//
//  발송인 명단에 등록된 수신자가 발송 계정으로 제목에 REQUEST_KEYWORD
//  ('통상 요청')를 포함해 메일을 보내면, 통합 모니터링 결과를 회신한다.
//  - 한 주기에 들어온 인가 요청자 전원에게 1회 수집 결과를 일괄 회신
//  - 동향DB/옵시디안 저장은 하지 않음 (정기 발송분과 중복 방지, 원래 설계 유지)
//  - 요청자별 일일 한도(ONDEMAND_DAILY_LIMIT) + 발신자 위조 남용 방지용 전역 한도
//
//  [재요청 인식 방식 — is:unread]
//  검색을 라벨 제외(-label:처리완료) 대신 is:unread 로 건다. 처리 후 항상
//  markRead() 하므로, 요청자가 같은 스레드에 답장하면 그 메일이 스레드를
//  다시 unread 로 되돌려 자연스럽게 재요청으로 인식된다. (예전에는 라벨이
//  스레드 전체를 검색에서 영구 제외해 답장이 와도 다시는 처리되지 않았다.)
//  PROCESSED_LABEL 은 이제 순수하게 사람이 보는 감사(audit) 표식일 뿐, 재요청
//  판별에는 관여하지 않는다.
//
//  [한도 차감 시점]
//  한도는 파이프라인 실행 "전"이 아니라 "그 요청자에게 실제 발송을 성공"한
//  직후에만 차감한다. 파이프라인이 실패하거나 특정 요청자 발송만 실패해도
//  그 요청자의 한도는 소모되지 않는다.
// ============================================================

function checkEmailRequests() {
  var startMs = Date.now();
  try {
    var label = GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);

    var authorized = getAuthorizedEmails();
    if (Object.keys(authorized).length === 0) { Logger.log('[요청] 발송인 명단 비어 있음'); return; }

    var query = 'subject:"' + REQUEST_KEYWORD + '" is:unread in:inbox';
    var threads = GmailApp.search(query, 0, 20);
    if (threads.length === 0) { Logger.log('[요청] 새 요청 없음'); return; }

    var cutoffMs = Date.now() - REQUEST_SEARCH_WINDOW_H * 60 * 60 * 1000;

    // 요청자 이메일 → 그 요청자의 처리 대상 스레드 목록
    var pendingByEmail = {};
    threads.forEach(function(thread) {
      var msgs = thread.getMessages();
      var msg = msgs[msgs.length - 1];
      var fromEmail = extractEmail(msg.getFrom()).toLowerCase();
      if ((msg.getSubject() || '').indexOf(REQUEST_KEYWORD) === -1) return;

      if (!authorized[fromEmail]) {
        Logger.log('[요청] 미인가 발신자 무시: ' + fromEmail);
        safeLabelAndRead(thread, label);
        return;
      }

      // 문서화된 REQUEST_SEARCH_WINDOW_H(시간)를 실제로 강제 — Gmail의 newer_than 은
      // 일(day) 단위 정밀도라 이 검증 없이는 며칠 지난 요청도 처리될 수 있었다.
      if (msg.getDate().getTime() < cutoffMs) {
        Logger.log('[요청] 오래된 요청(>' + REQUEST_SEARCH_WINDOW_H + '시간) 무시: ' + fromEmail);
        safeLabelAndRead(thread, label);
        try {
          GmailApp.sendEmail(fromEmail, '[통상 모니터링] 요청이 만료되었습니다',
            '요청 메일이 ' + REQUEST_SEARCH_WINDOW_H + '시간보다 오래되어 처리하지 않았습니다. 다시 요청해 주세요.');
        } catch (e) { /* 무시 */ }
        return;
      }

      if (!pendingByEmail[fromEmail]) pendingByEmail[fromEmail] = [];
      pendingByEmail[fromEmail].push(thread);
    });

    var requesters = Object.keys(pendingByEmail);
    if (requesters.length === 0) return;

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_REQUEST_MS)) {
      Logger.log('[요청] 잠금 실패(정기 실행 중 추정) → 다음 폴링에서 처리'); return;
    }

    try {
      // 한도 확인은 "잔여량 조회"만 하고 차감(commit)은 실제 발송 성공 후에 한다.
      var allowed = [];
      requesters.forEach(function(em) {
        if (quotaRemaining('ONDEMAND_COUNTS', em, ONDEMAND_DAILY_LIMIT) <= 0) {
          Logger.log('[요청] 개인 일일 한도 초과: ' + em);
          try {
            GmailApp.sendEmail(em, '[통상 모니터링] 일일 요청 한도 초과',
              '온디맨드 요청은 1인당 하루 최대 ' + ONDEMAND_DAILY_LIMIT + '회까지 처리됩니다. 내일 다시 요청해 주세요.');
          } catch (e) { /* 무시 */ }
          pendingByEmail[em].forEach(function(t) { safeLabelAndRead(t, label); });
          return;
        }
        if (quotaRemaining('ONDEMAND_GLOBAL_COUNTS', 'ALL', ONDEMAND_GLOBAL_DAILY_LIMIT) <= 0) {
          // 전역 한도는 From 헤더 스푸핑으로 여러 주소를 돌려가며 남용하는 것을 막는
          // 안전판이다. 이 경우 처리완료 표시를 하지 않고 그대로 두어(unread 유지)
          // 다음 폴링(또는 자정 이후 한도 초기화)에서 자동으로 다시 고려되게 한다.
          Logger.log('[요청] 전역 일일 한도 초과 — 이연: ' + em);
          return;
        }
        allowed.push(em);
      });

      if (allowed.length > 0) {
        Logger.log('[요청] 처리 시작 → ' + allowed.join(', '));
        try {
          var result = runMonitoringCore({ startMs: startMs });
          var dateStr = Utilities.formatDate(result.now, 'Asia/Seoul', 'yyyy년 MM월 dd일');
          var subject = '[글로벌 통상 모니터링] ' + dateStr + buildSubjectTriage(result.stats) + ' (요청)';
          // 요청자별 관심영역(F열)을 반영해 담당 영역을 맨 앞에 배치
          var focusMap = {};
          getRecipients().forEach(function(r) { focusMap[r.email.toLowerCase()] = r.focus; });
          allowed.forEach(function(em) {
            try {
              var html = buildCombinedEmailHTML(result.data, result.insights, result.now, result.fromDate,
                result.stats, result.failedUnits, focusMap[em] || '');
              GmailApp.sendEmail(em, subject,
                '이 메일은 HTML 형식입니다. HTML 뷰어로 확인하세요.',
                { htmlBody: html, name: '통상 모니터링 시스템' });
              Logger.log('[요청] 발송 완료 → ' + em);
              // 실제 발송 성공 후에만 한도 차감 + 처리완료 표시.
              commitQuota('ONDEMAND_COUNTS', em);
              commitQuota('ONDEMAND_GLOBAL_COUNTS', 'ALL');
              pendingByEmail[em].forEach(function(t) { safeLabelAndRead(t, label); });
            } catch (se) {
              Logger.log('[요청] 발송 실패 (' + em + '): ' + se.message);
              // 실패 시 한도 차감/라벨 모두 하지 않음 → 다음 폴링에서 자동 재시도
            }
          });
          logExecution('요청', allowed.length, result.stats, allowed.join(', '));
        } catch (runErr) {
          Logger.log('[요청] 실행 오류: ' + runErr.message);
          // 파이프라인 자체가 실패한 경우: 한도는 차감하지 않되, 5분마다 같은 무거운
          // 파이프라인이 무한 재시도되는 것을 막기 위해 처리완료 표시는 한다.
          // 요청자가 다시 요청하고 싶으면 같은 스레드에 답장하면 되고(is:unread 로
          // 재노출), 그때는 한도가 그대로 남아있으므로 손해가 없다.
          allowed.forEach(function(em) {
            try {
              GmailApp.sendEmail(em, '[통상 모니터링] 요청 처리 중 오류',
                '요청 처리 중 오류가 발생했습니다.\n오류: ' + runErr.message +
                '\n\n한도는 차감되지 않았습니다. 다시 요청해 주세요.');
            } catch (se) { /* 무시 */ }
            pendingByEmail[em].forEach(function(t) { safeLabelAndRead(t, label); });
          });
        }
      }
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('[요청] 치명적 오류: ' + e.message);
  }
}

/** 스레드에 라벨 부착 + 읽음 처리. 각각 독립적으로 실패해도 나머지 처리에 영향 없음. */
function safeLabelAndRead(thread, label) {
  try { label.addToThread(thread); } catch (e) { Logger.log('[요청] 라벨 부착 실패: ' + e.message); }
  try { thread.markRead(); } catch (e) { Logger.log('[요청] 읽음 처리 실패: ' + e.message); }
}

// ── 일일 한도 공용 헬퍼 (요청자별 ONDEMAND_COUNTS / 전역 ONDEMAND_GLOBAL_COUNTS) ──
// KST 날짜가 바뀌면 자동 초기화되는 { date, counts:{id:count} } 상태를 스크립트
// 속성에 보관한다. quotaRemaining 은 조회만 하고, commitQuota 를 호출해야 차감된다
// — 이 분리 덕분에 "성공한 발송만 한도를 쓴다"를 호출부에서 강제할 수 있다.
function readQuotaState(propKey) {
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var state = null;
  try { state = JSON.parse(PropertiesService.getScriptProperties().getProperty(propKey) || 'null'); } catch (e) { /* 재생성 */ }
  if (!state || state.date !== today) state = { date: today, counts: {} };
  return state;
}

function quotaRemaining(propKey, id, limit) {
  var state = readQuotaState(propKey);
  return limit - (state.counts[id] || 0);
}

function commitQuota(propKey, id) {
  var state = readQuotaState(propKey);
  state.counts[id] = (state.counts[id] || 0) + 1;
  PropertiesService.getScriptProperties().setProperty(propKey, JSON.stringify(state));
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
