// ============================================================
//  구글 시트: 초기화 · 저장(도메인별) · 중복 제거 · 수신자 · 로그
// ============================================================

/** 시트 초기화 (최초 1회) — 도메인별 동향DB + 발송인 명단 + 발송로그 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  DOMAINS.forEach(function(domain) {
    var sh = ss.getSheetByName(domain.dbSheet);
    if (!sh) {
      sh = ss.insertSheet(domain.dbSheet);
      sh.getRange(1, 1, 1, domain.dbHeader.length).setValues([domain.dbHeader])
        .setFontWeight('bold').setBackground('#1a2a4a').setFontColor('#ffffff');
      sh.setFrozenRows(1);
      Logger.log(domain.dbSheet + ' 생성');
    } else {
      ensureDbHeader(sh, domain.dbHeader);
    }
  });

  var list = ss.getSheetByName(SHEET_RECIPIENTS);
  if (!list) {
    list = ss.insertSheet(SHEET_RECIPIENTS);
    list.getRange(1, 1, 1, 5).setValues([['이름', '이메일', '부서', '직급', '발송여부']])
      .setFontWeight('bold').setBackground('#1a2a4a').setFontColor('#ffffff');
    list.setFrozenRows(1);
    list.getRange(2, 1, 1, 5).setValues([['홍길동(예시)', 'example@company.com', '', '', 'Y']]);
    Logger.log(SHEET_RECIPIENTS + ' 생성 (B:이메일, E:발송여부 Y/N)');
  }

  var log = ss.getSheetByName(SHEET_LOG);
  if (!log) {
    log = ss.insertSheet(SHEET_LOG);
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS])
      .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
    log.setFrozenRows(1);
    Logger.log(SHEET_LOG + ' 생성');
  }

  Logger.log('=== 시트 초기화 완료 ===');
}

/** 기존 시트에 신규 컬럼을 맨 끝에 자동 추가 (마이그레이션) */
function ensureDbHeader(sheet, header) {
  var lastCol = sheet.getLastColumn();
  if (lastCol >= header.length) return;
  sheet.getRange(1, lastCol + 1, 1, header.length - lastCol)
    .setValues([header.slice(lastCol)])
    .setFontWeight('bold').setBackground('#1a2a4a').setFontColor('#ffffff');
  Logger.log(sheet.getName() + ' 헤더 확장: ' + header.slice(lastCol).join(', '));
}

/** 전 도메인 항목을 각 도메인 DB 시트에 저장 */
function saveAllToSheets(data, now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dateStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  DOMAINS.forEach(function(domain) {
    var sheet = ss.getSheetByName(domain.dbSheet);
    if (!sheet) {
      sheet = ss.insertSheet(domain.dbSheet);
      sheet.getRange(1, 1, 1, domain.dbHeader.length).setValues([domain.dbHeader])
        .setFontWeight('bold').setBackground('#1a2a4a').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    } else {
      ensureDbHeader(sheet, domain.dbHeader);
    }

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

/** 도메인 DB 최근 N일 제목(정규화) 로드. beforeDate 이후 수집분은 제외. */
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
      if (!when || when < cutoff || when >= beforeDate) return;
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

/** 도메인 내(카테고리 간) + 과거 제목 대비 중복 제거 (정규화 일치 또는 Dice 임계) */
function dedupeDomain(domainData, historyTitles) {
  var seen = historyTitles.slice();
  var removed = 0;
  Object.keys(domainData).forEach(function(unitKey) {
    var kept = [];
    (domainData[unitKey] || []).forEach(function(it) {
      var n = normalizeTitle(it.title);
      var dup = false;
      if (n) {
        for (var i = 0; i < seen.length; i++) {
          if (seen[i] === n || diceSimilarity(seen[i], n) >= DEDUPE_SIMILARITY) { dup = true; break; }
        }
      }
      if (dup) { removed++; }
      else { kept.push(it); if (n) seen.push(n); }
    });
    domainData[unitKey] = kept;
  });
  if (removed > 0) Logger.log('[중복] ' + removed + '건 제거');
}

/** 발송인 명단 → [{name,email}] (B열 이메일, E열 발송여부: 비었거나 Y면 발송) */
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
  } catch (e) { Logger.log('[getRecipients] ' + e.message); }
  return out;
}

/** 요청 인증용: 활성 수신자 이메일(소문자) → 이름 맵 */
function getAuthorizedEmails() {
  var map = {};
  getRecipients().forEach(function(r) { map[r.email.toLowerCase()] = r.name; });
  return map;
}

/** 발송 이력 기록 */
function logExecution(type, sentCount, stats, note) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_LOG);
      sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS])
        .setFontWeight('bold').setBackground('#37474f').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
    var d = stats.byDomain;
    sheet.appendRow([
      Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'),
      type, sentCount, d.customs.total, d.export.total, d.trade.total, stats.high, note || ''
    ]);
  } catch (e) { Logger.log('[logExecution] ' + e.message); }
}
