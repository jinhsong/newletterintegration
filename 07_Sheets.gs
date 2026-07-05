// ============================================================
//  구글 시트: 초기화 · 저장(도메인별) · 중복 제거 · 수신자 · 로그
// ============================================================

/**
 * 시트가 없으면 스타일이 적용된 헤더와 함께 생성, 있으면 헤더 마이그레이션만 확인.
 * initializeSheets/saveAllToSheets/logExecution 3곳에서 반복되던 생성 로직을 통합.
 */
function getOrCreateSheet(ss, name, header, headerColor) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground(headerColor).setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    Logger.log(name + ' 생성');
  } else {
    ensureDbHeader(sheet, header, headerColor);
  }
  return sheet;
}

/** 시트 초기화 (최초 1회) — 도메인별 동향DB + 발송인 명단 + 발송로그 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  DOMAINS.forEach(function(domain) {
    getOrCreateSheet(ss, domain.dbSheet, domain.dbHeader, '#1a2a4a');
  });

  var list = ss.getSheetByName(SHEET_RECIPIENTS);
  if (!list) {
    list = ss.insertSheet(SHEET_RECIPIENTS);
    list.getRange(1, 1, 1, 5).setValues([['이름', '이메일', '부서', '직급', '발송여부']])
      .setFontWeight('bold').setBackground('#1a2a4a').setFontColor('#ffffff');
    list.setFrozenRows(1);
    list.getRange(2, 1, 1, 5).setValues([['홍길동(예시)', 'example@company.com', '', '', '']]);
    Logger.log(SHEET_RECIPIENTS + ' 생성 (B:이메일, E:발송여부 — N이면 제외, 그 외/빈칸은 발송)');
  }

  getOrCreateSheet(ss, SHEET_LOG, logHeaders(), '#37474f');

  Logger.log('=== 시트 초기화 완료 ===');
}

/** 기존 시트에 신규 컬럼을 맨 끝에 자동 추가 (마이그레이션) */
function ensureDbHeader(sheet, header, headerColor) {
  var lastCol = sheet.getLastColumn();
  if (lastCol >= header.length) return;
  sheet.getRange(1, lastCol + 1, 1, header.length - lastCol)
    .setValues([header.slice(lastCol)])
    .setFontWeight('bold').setBackground(headerColor || '#1a2a4a').setFontColor('#ffffff');
  Logger.log(sheet.getName() + ' 헤더 확장: ' + header.slice(lastCol).join(', '));
}

/** 전 도메인 항목을 각 도메인 DB 시트에 저장 */
function saveAllToSheets(data, now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dateStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  DOMAINS.forEach(function(domain) {
    var sheet = getOrCreateSheet(ss, domain.dbSheet, domain.dbHeader, '#1a2a4a');

    var rows = [];
    domain.units.forEach(function(u) {
      (data[domain.key][u.key] || []).forEach(function(it) {
        rows.push(domain.dbRow(it, u.label, dateStr));
      });
    });

    if (rows.length > 0) {
      var last = sheet.getLastRow();
      sheet.getRange(last + 1, 1, rows.length, domain.dbHeader.length).setValues(rows);
      Logger.log(domain.label + ' ' + rows.length + '건 저장');
    }
  });
}

/**
 * 도메인 DB 최근 N일 제목(정규화) 로드.
 * 과거에는 "beforeDate 이후 저장분 제외" 조건이 있었으나, 전날 실행이 beforeDate
 * 경계 근처(트리거 실행 분(分)이 매일 달라짐)에 저장을 마치면 어제 항목 전체가
 * 이력에서 빠져 같은 기사가 이틀 연속 발송되는 버그가 있었다. loadRecentTitles 는
 * 항상 이번 실행의 저장(saveAllToSheets) 이전에 호출되므로 그런 배제는 애초에
 * 불필요했다 — lookback 기간 내 저장분은 전부 이력에 포함한다.
 */
function loadRecentTitles(domain, days, beforeDate) {
  var titles = [];
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(domain.dbSheet);
    if (!sheet || sheet.getLastRow() < 2) return titles;
    var lastRow = sheet.getLastRow();
    var startRow = Math.max(2, lastRow - DEDUPE_HISTORY_MAX_ROWS + 1);
    // 1열=수집일시, 4열=제목 (전 도메인 동일 위치)
    var rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, 4).getValues();
    var cutoff = new Date(beforeDate.getTime() - days * 24 * 60 * 60 * 1000);
    rows.forEach(function(r) {
      var when = parseSheetDate(r[0]);
      if (!when || when < cutoff) return;
      var n = normalizeTitle(r[3]);
      if (n) titles.push(n);
    });
  } catch (e) { Logger.log('[loadRecentTitles/' + domain.label + '] ' + e.message); }
  return titles;
}

function parseSheetDate(v) {
  if (v instanceof Date) return v;
  var m = (v || '').toString().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** 정규화된 제목 n 이 title 목록(seen)에 이미 있는지 (정확 일치 또는 Dice 유사도 임계 이상) */
function isDupTitle(n, seen) {
  if (!n) return false;
  for (var i = 0; i < seen.length; i++) {
    if (seen[i] === n || diceSimilarity(seen[i], n) >= DEDUPE_SIMILARITY) return true;
  }
  return false;
}

/** 도메인 내(카테고리 간) + 과거 제목 대비 중복 제거 (정규화 일치 또는 Dice 임계) */
function dedupeDomain(domainData, historyTitles) {
  var seen = historyTitles.slice();
  var removed = 0;
  Object.keys(domainData).forEach(function(unitKey) {
    var kept = [];
    (domainData[unitKey] || []).forEach(function(it) {
      var n = normalizeTitle(it.title);
      if (isDupTitle(n, seen)) { removed++; }
      else { kept.push(it); if (n) seen.push(n); }
    });
    domainData[unitKey] = kept;
  });
  if (removed > 0) Logger.log('[중복] ' + removed + '건 제거');
}

/**
 * 교차 영역 중복 제거 (안전망): 프롬프트 경계를 넘어 같은 사안이 두 영역에
 * 동시에 잡히는 경우 대비. "전문 영역"(generalBucket 이 아닌 도메인)에 잡힌
 * 제목과 겹치는 항목을 "일반 버킷" 도메인(generalBucket: true, 현재는 관세)에서
 * 제거한다. 도메인 목록은 하드코딩하지 않고 DOMAINS 설정을 그대로 따르므로,
 * 새 도메인을 추가해도(01_Config.gs 의 generalBucket 플래그만 정하면) 자동 반영된다.
 */
function removeCrossDomainOverlap(data) {
  var generalDomains = DOMAINS.filter(function(d) { return d.generalBucket; });
  var specializedDomains = DOMAINS.filter(function(d) { return !d.generalBucket; });
  if (generalDomains.length === 0 || specializedDomains.length === 0) return;

  var specialized = [];
  specializedDomains.forEach(function(domain) {
    domain.units.forEach(function(u) {
      (data[domain.key][u.key] || []).forEach(function(it) {
        var n = normalizeTitle(it.title);
        if (n) specialized.push(n);
      });
    });
  });
  if (specialized.length === 0) return;

  var removed = 0;
  generalDomains.forEach(function(domain) {
    domain.units.forEach(function(u) {
      var kept = [];
      (data[domain.key][u.key] || []).forEach(function(it) {
        var n = normalizeTitle(it.title);
        if (isDupTitle(n, specialized)) {
          removed++;
          Logger.log('[교차중복] ' + domain.label + '에서 제거(전문 영역 우선): ' + it.title);
        } else {
          kept.push(it);
        }
      });
      data[domain.key][u.key] = kept;
    });
  });
  if (removed > 0) Logger.log('[교차중복] 합계 ' + removed + '건 제거');
}

/** 발송인 명단 → [{name,email}] (B열 이메일, E열 발송여부: N이면 제외, 그 외/빈칸은 발송) */
function getRecipients() {
  var out = [];
  var seen = {};
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RECIPIENTS);
    if (!sheet || sheet.getLastRow() < 2) return out;
    var numCols = Math.min(sheet.getLastColumn(), 6);
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, numCols).getValues();
    rows.forEach(function(r) {
      var email = (r[1] || '').toString().trim();
      if (email.indexOf('@') === -1) return;
      var active = (r[4] || '').toString().trim().toUpperCase();
      if (active === 'N') return; // E열 N 이면 제외 (빈칸/Y 는 발송)
      var key = email.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ name: (r[0] || '').toString(), email: email });
    });
  } catch (e) {
    // 일시적 조회 오류와 "명단이 정말 비어있음"을 구분하지 못하면 상위(sendCombinedEmail)가
    // 그날 발송을 조용히 건너뛰고 아무도 모르게 지나갈 수 있다 — 반드시 관리자에게 알림.
    Logger.log('[getRecipients] ' + e.message);
    notifyAdmin('[주의] 발송인 명단 조회 실패', '수신자 목록을 읽는 중 오류가 발생했습니다.\n오류: ' + e.message);
  }
  return out;
}

/** 요청 인증용: 활성 수신자 이메일(소문자) → 이름 맵 */
function getAuthorizedEmails() {
  var map = {};
  getRecipients().forEach(function(r) { map[r.email.toLowerCase()] = r.name; });
  return map;
}

/** 발송 이력 기록 (도메인별 건수 열은 DOMAINS 순서를 그대로 따름 — logHeaders() 참조) */
function logExecution(type, sentCount, stats, note) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = getOrCreateSheet(ss, SHEET_LOG, logHeaders(), '#37474f');
    var row = [Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'), type, sentCount]
      .concat(DOMAINS.map(function(d) { return stats.byDomain[d.key].total; }))
      .concat([stats.high, note || '']);
    sheet.appendRow(row);
  } catch (e) { Logger.log('[logExecution] ' + e.message); }
}
