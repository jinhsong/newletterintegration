// ============================================================
//  옵시디안(Obsidian) 저장 — Google Drive 폴더에 통합 마크다운 1개
//  저장 폴더 우선순위: 스크립트 속성 OBSIDIAN_FOLDER_ID > 폴더명 OBSIDIAN_FOLDER
//  미설정 시에도 폴더명으로 검색/생성하여 저장 (저장 자체를 건너뛰지 않음)
// ============================================================

/** Drive 폴더 URL/ID 문자열 → 순수 폴더 ID. 식별 불가 시 빈 문자열. */
function extractDriveFolderId(input) {
  var s = (input || '').toString().trim();
  if (!s) return '';
  var m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return '';
}

/** 옵시디안 저장 폴더 반환 (ID 우선, 없으면 폴더명 검색/생성) */
function getObsidianFolder() {
  var id = '';
  try { id = (PropertiesService.getScriptProperties().getProperty(OBSIDIAN_FOLDER_ID_PROP) || '').trim(); }
  catch (e) { /* 폴더명 폴백 */ }
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (e) { Logger.log('[옵시디안] 폴더 ID 접근 실패 → 폴더명 폴백: ' + e.message); }
  }
  var folders = DriveApp.getFoldersByName(OBSIDIAN_FOLDER);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(OBSIDIAN_FOLDER);
}

/** 옵시디안 폴더 ID 지정 (1회 실행). Drive 폴더 URL 도 허용. */
function setObsidianFolderId(folderIdOrUrl) {
  var folderId = extractDriveFolderId(folderIdOrUrl);
  if (!folderId) throw new Error('유효한 폴더 ID 를 찾을 수 없습니다: ' + folderIdOrUrl);
  var folder = DriveApp.getFolderById(folderId);
  PropertiesService.getScriptProperties().setProperty(OBSIDIAN_FOLDER_ID_PROP, folderId);
  Logger.log('옵시디안 폴더 설정: "' + folder.getName() + '" (' + folderId + ')');
  return folderId;
}

function showObsidianFolderId() {
  var id = PropertiesService.getScriptProperties().getProperty(OBSIDIAN_FOLDER_ID_PROP);
  if (!id) { Logger.log('[옵시디안] OBSIDIAN_FOLDER_ID 미설정 (폴더명 "' + OBSIDIAN_FOLDER + '" 사용)'); return; }
  try { Logger.log('[옵시디안] 현재 폴더: "' + DriveApp.getFolderById(id).getName() + '" (' + id + ')'); }
  catch (e) { Logger.log('[옵시디안] ID ' + id + ' 접근 불가: ' + e.message); }
}

/** 마크다운 인라인 텍스트 이스케이프: 줄바꿈 제거, 헤딩/리스트를 깨는 선행 기호 무력화 */
function mdInline(s) {
  s = (s || '').toString().replace(/[\r\n]+/g, ' ').trim();
  return s.replace(/^(#{1,6}\s|[-*+]\s|\d+\.\s)/, '\\$&');
}

/** 마크다운 링크 [label](url) 생성. label/url 에 링크 문법을 깨는 문자가 있으면 안전하게 이스케이프. */
function mdLink(label, url) {
  var safeLabel = mdInline(label).replace(/[\[\]]/g, '\\$&');
  var safeUrl = (url || '').toString().replace(/[\r\n\s]+/g, '').replace(/\)/g, '%29');
  if (!/^https?:\/\//i.test(safeUrl)) return mdInline(label); // http(s) 아니면 링크화하지 않음
  return '[' + safeLabel + '](' + safeUrl + ')';
}

function clearObsidianFolderId() {
  PropertiesService.getScriptProperties().deleteProperty(OBSIDIAN_FOLDER_ID_PROP);
  Logger.log('[옵시디안] 폴더 ID 해제 → 폴더명("' + OBSIDIAN_FOLDER + '") 방식 전환');
}


// ============================================================
//  발송 결과 스냅샷 (재전송용)
//  직전 발송의 data/insights/시각을 Drive JSON 으로 저장해 두었다가,
//  resendLastBriefing() 이 재수집 없이 그대로 재발송할 수 있게 한다.
//  (스크립트 속성은 값당 9KB 제한이라 큰 HTML/데이터를 담기 어려워 Drive 파일 사용.)
// ============================================================
var SNAPSHOT_FILE = '_last_run_snapshot.json';

function saveResultSnapshot(result) {
  try {
    var folder = getObsidianFolder();
    var payload = JSON.stringify({
      nowISO: result.now.toISOString(),
      fromISO: result.fromDate.toISOString(),
      data: result.data,
      insights: result.insights,
      failedUnits: result.failedUnits || []
    });
    var files = folder.getFilesByName(SNAPSHOT_FILE);
    if (files.hasNext()) files.next().setContent(payload);
    else folder.createFile(SNAPSHOT_FILE, payload, 'application/json');
    Logger.log('[스냅샷] 저장 완료 (' + payload.length + ' bytes)');
  } catch (e) {
    Logger.log('[스냅샷] 저장 실패(재전송 불가 가능): ' + e.message);
  }
}

/**
 * 직전 발송 스냅샷을 읽어 sendCombinedEmail 이 바로 쓸 수 있는 result 형태로 복원.
 * @returns {Object|null} { data, insights, now, fromDate, stats, failedUnits } 또는 없으면 null
 */
function loadResultSnapshot() {
  var folder = getObsidianFolder();
  var files = folder.getFilesByName(SNAPSHOT_FILE);
  if (!files.hasNext()) return null;
  var raw = files.next().getBlob().getDataAsString('UTF-8');
  var s = JSON.parse(raw);
  var now = new Date(s.nowISO);
  var fromDate = new Date(s.fromISO);
  return {
    data: s.data,
    insights: s.insights,
    now: now,
    fromDate: fromDate,
    stats: computeStats(s.data, now),
    failedUnits: s.failedUnits || []
  };
}

function saveToObsidian(data, insights, now, fromDate) {
  try {
    var folder = getObsidianFolder();
    var dateStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
    var timeStr = Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
    var fromStr = Utilities.formatDate(fromDate, 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
    var fileName = dateStr + ' 글로벌 통상 동향.md';
    var stats = computeStats(data, now);

    var md = '';
    md += '---\n';
    md += 'title: 글로벌 통상 동향 ' + dateStr + '\n';
    md += 'date: ' + dateStr + '\n';
    md += 'tags: [통상동향, 관세, 수출통제, 무역구제, 자동수집]\n';
    md += '수집범위: ' + fromStr + ' ~ ' + dateStr + ' ' + timeStr + ' KST\n';
    md += '총건수: ' + stats.total + '\n';
    md += '---\n\n';
    md += '# 글로벌 통상 일일 모니터링 (' + dateStr + ')\n\n';
    md += '> 수집 범위: ' + fromStr + ' ~ ' + dateStr + ' ' + timeStr + ' KST · 총 ' + stats.total + '건 (상 ' + stats.high + ')\n\n';
    md += DOMAINS.map(function(d) { return d.label + ' ' + stats.byDomain[d.key].total + '건'; }).join(' · ') + '\n\n';

    DOMAINS.forEach(function(domain) {
      var di = insights[domain.key] || {};
      md += '\n# [' + domain.label + '] ' + domain.obsidianTitle + '\n\n';
      if (di.overall) md += '## 총평\n\n' + di.overall + '\n\n';

      domain.units.forEach(function(u) {
        var items = data[domain.key][u.key] || [];
        md += '## ' + u.label + ' (' + items.length + '건)\n\n';
        if (di.byCategory && di.byCategory[u.key]) md += '> ' + di.byCategory[u.key] + '\n\n';
        if (items.length === 0) { md += '_해당 수집 기간 내 동향 없음_\n\n'; return; }

        sortByImportance(items).forEach(function(it) {
          md += '### [' + (it.importance || '-') + '] ' + mdInline(it.title) + '\n\n';
          if (it.gubun) md += '- **구분**: ' + mdInline(it.gubun) + '\n';
          md += '- **발표일**: ' + (it.announcedDate || '-') + '\n';
          if ((it.effectiveDate || '').trim()) md += '- **시행일**: ' + it.effectiveDate + '\n';
          if ((it.hsCode || '').trim()) md += '- **HS코드**: ' + it.hsCode + '\n';
          if ((it.issuingCountry || '').trim()) md += '- **발표국가**: ' + mdInline(it.issuingCountry) + '\n';
          if ((it.targetCountries || '').trim()) md += '- **대상/영향국**: ' + mdInline(it.targetCountries) + '\n';
          if ((it.agency || '').trim()) md += '- **관련기관**: ' + mdInline(it.agency) + '\n';
          if ((it.sourceName || '').trim()) md += '- **출처**: ' + mdInline(it.sourceName) + '\n';
          md += '\n' + mdInline(it.summary) + '\n\n';
          if ((it.notes || '').trim()) md += '> 비고: ' + mdInline(it.notes) + '\n\n';
          var link = getItemLink(it);
          if (link) {
            md += mdLink(link.isOriginal ? '원문: ' + link.label : 'Google 검색', link.url);
            if (it.sourceUrl2) md += ' · ' + mdLink(it.sourceDomain2 || '관련 출처', it.sourceUrl2);
            md += '\n\n';
          }
          md += '---\n\n';
        });
      });
    });

    var existing = folder.getFilesByName(fileName);
    if (existing.hasNext()) { existing.next().setContent(md); Logger.log('옵시디안 갱신: ' + fileName); }
    else { folder.createFile(fileName, md, MimeType.PLAIN_TEXT); Logger.log('옵시디안 생성: ' + fileName); }
  } catch (e) {
    Logger.log('[saveToObsidian] ' + e.message);
  }
}
