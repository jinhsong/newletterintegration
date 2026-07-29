// ============================================================
//  Gemini CLI Enterprise 연동 (Google Drive inbox 방식)
//
//  로컬 PC:
//    Gemini CLI(사내 OAuth) → trade-monitor-pending-YYYY-MM-DD.json
//                          → Google Drive for desktop 동기화 폴더
//
//  Apps Script:
//    processCliInbox() → 날짜/중복/URL 검증 → 기존 HTML/메일/시트/옵시디안
//
//  공개 Web App이나 Gemini API 키를 사용하지 않는다. CLI 결과 파일이 놓이는
//  Drive 폴더는 발송 계정과 로컬 PC의 회사 계정만 접근할 수 있게 공유한다.
// ============================================================

/** 현재 런타임이 Gemini CLI inbox 모드인지 확인 */
function isCliRuntime_() {
  return PropertiesService.getScriptProperties().getProperty(MONITORING_RUNTIME_PROP) === 'CLI';
}

/**
 * CLI inbox용 Drive 폴더 지정. 폴더 URL 전체 또는 ID를 허용한다.
 * 로컬 PC에서는 같은 폴더를 Google Drive for desktop으로 동기화해야 한다.
 */
function setCliInboxFolderId(folderIdOrUrl) {
  var id = extractDriveFolderId(folderIdOrUrl);
  if (!id) throw new Error('유효한 Drive 폴더 ID를 찾을 수 없습니다: ' + folderIdOrUrl);
  var folder = DriveApp.getFolderById(id);
  folder.getName(); // 존재/권한 확인
  PropertiesService.getScriptProperties().setProperty(CLI_INBOX_FOLDER_ID_PROP, id);
  Logger.log('[CLI inbox] 폴더 설정 완료: "' + folder.getName() + '" (' + id + ')');
  return id;
}

/** CLI inbox 폴더 연결 상태 확인 */
function showCliInboxFolderId() {
  var id = PropertiesService.getScriptProperties().getProperty(CLI_INBOX_FOLDER_ID_PROP);
  if (!id) {
    Logger.log('[CLI inbox] 미설정 — setCliInboxFolderId()를 먼저 실행하세요.');
    return;
  }
  try {
    Logger.log('[CLI inbox] 현재 폴더: "' + DriveApp.getFolderById(id).getName() + '" (' + id + ')');
  } catch (e) {
    Logger.log('[CLI inbox] 접근 실패 (' + id + '): ' + e.message);
  }
}

/**
 * Gemini CLI 운용 모드 활성화.
 * 기존 API 정기/온디맨드 트리거를 제거하고 Drive inbox 폴링만 5분마다 등록한다.
 */
function setupCliModeTriggers() {
  var id = PropertiesService.getScriptProperties().getProperty(CLI_INBOX_FOLDER_ID_PROP);
  if (!id) throw new Error('CLI_INBOX_FOLDER_ID 미설정 — setCliInboxFolderId()를 먼저 실행하세요.');
  DriveApp.getFolderById(id).getName(); // 접근 가능 여부 확인

  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runDailyMonitoring' || fn === 'checkEmailRequests' || fn === 'processCliInbox') {
      ScriptApp.deleteTrigger(t);
    }
  });
  PropertiesService.getScriptProperties().setProperty(MONITORING_RUNTIME_PROP, 'CLI');
  ScriptApp.newTrigger('processCliInbox').timeBased().everyMinutes(5).create();
  Logger.log('Gemini CLI 모드 활성화: Drive inbox 5분 폴링 (API 정기/온디맨드 트리거 제거)');
}

/**
 * API 모드로 복귀. setupTriggers()가 평일 정기 + 온디맨드 트리거를 다시 등록한다.
 * GEMINI_API_KEY가 설정된 경우에만 사용한다.
 */
function setupApiModeTriggers() {
  PropertiesService.getScriptProperties().setProperty(MONITORING_RUNTIME_PROP, 'API');
  setupTriggers();
  Logger.log('Gemini API 모드 활성화');
}

/** CLI inbox 폴더 객체 반환 */
function getCliInboxFolder_() {
  var id = PropertiesService.getScriptProperties().getProperty(CLI_INBOX_FOLDER_ID_PROP);
  if (!id) throw new Error('CLI_INBOX_FOLDER_ID 스크립트 속성이 설정되지 않았습니다.');
  return DriveApp.getFolderById(id);
}

/** 지정한 이름의 하위 폴더 조회/생성 */
function getOrCreateCliChildFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/**
 * 5분 트리거 진입점. pending 파일 중 가장 오래된 1개만 처리한다.
 * 한 실행에서 여러 메일이 연속 발송되는 사고를 막기 위해 의도적으로 1개만 처리한다.
 */
function processCliInbox() {
  if (!isCliRuntime_()) {
    Logger.log('[CLI inbox] CLI 모드가 아니므로 생략');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_REQUEST_MS)) {
    Logger.log('[CLI inbox] 다른 실행 진행 중 → 다음 폴링에서 재시도');
    return;
  }

  var file = null;
  try {
    var inbox = getCliInboxFolder_();
    var files = inbox.getFiles();
    var pending = [];
    while (files.hasNext()) {
      var f = files.next();
      var n = f.getName();
      if (n.indexOf(CLI_INBOX_PENDING_PREFIX) === 0 && /\.json$/i.test(n)) pending.push(f);
    }
    if (pending.length === 0) {
      Logger.log('[CLI inbox] 대기 파일 없음');
      return;
    }

    pending.sort(function(a, b) { return a.getDateCreated().getTime() - b.getDateCreated().getTime(); });
    file = pending[0];
    if (file.getSize() > CLI_INBOX_MAX_BYTES) {
      throw new Error('CLI payload가 허용 크기를 초과했습니다: ' + file.getSize() + ' bytes');
    }

    var payload = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    var outcome = processCliPayload_(payload);

    var processed = getOrCreateCliChildFolder_(inbox, '_processed');
    file.setName('processed-' + file.getName()).moveTo(processed);
    Logger.log('[CLI inbox] 처리 완료: ' + JSON.stringify(outcome));
  } catch (e) {
    Logger.log('[CLI inbox] 처리 실패: ' + e.message + '\n' + (e.stack || ''));
    notifyAdmin('[오류] Gemini CLI 결과 처리 실패',
      'Drive inbox 파일 처리에 실패했습니다.\n\n파일: ' +
      (file ? file.getName() : '(파일 선택 전)') + '\n오류: ' + e.message);
    if (file) {
      try {
        var failed = getOrCreateCliChildFolder_(getCliInboxFolder_(), '_failed');
        file.setName('failed-' + file.getName()).moveTo(failed);
      } catch (moveErr) {
        Logger.log('[CLI inbox] 실패 파일 이동도 실패: ' + moveErr.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** CLI payload 검증·발송 파이프라인 */
function processCliPayload_(payload) {
  validateCliPayload_(payload);

  var props = PropertiesService.getScriptProperties();
  var deliveryKey = cliText_(payload.deliveryKey, 80);
  var lastKey = props.getProperty(CLI_LAST_DELIVERY_KEY_PROP);
  if (lastKey && lastKey === deliveryKey) {
    Logger.log('[CLI inbox] 이미 처리한 deliveryKey → 중복 발송 생략: ' + deliveryKey);
    return { duplicate: true, deliveryKey: deliveryKey };
  }

  var startMs = Date.now();
  var now = new Date(payload.nowISO);
  var fromDate = new Date(payload.fromISO);
  var ctx = buildPromptContext(now, fromDate);
  var data = normalizeCliData_(payload.data);

  // CLI 결과라도 서버 측에서 날짜·과거 이력·교차 영역 중복을 다시 검증한다.
  forEachUnit(data, function(domain, unit, items, setItems) {
    setItems(filterByDate(items, ctx.fromISO, ctx.toISO));
  });
  DOMAINS.forEach(function(domain) {
    var history = loadRecentTitles(domain, DEDUPE_LOOKBACK_DAYS, fromDate);
    dedupeDomain(data[domain.key], history);
  });
  removeCrossDomainOverlap(data);

  // CLI는 원본 groundingMetadata를 노출하지 않으므로 모델 제공 URL 검증과
  // RSS 검색 폴백을 서버 측에서 수행한다.
  findSourceUrls(data, startMs);
  enforceRecency(data, fromDate);

  var insights = normalizeCliInsights_(payload.insights);
  var failedUnits = normalizeCliFailedUnits_(payload.failedUnits);
  var stats = computeStats(data, now);
  var html = buildCombinedEmailHTML(data, insights, now, fromDate, stats, failedUnits);
  var result = {
    html: html,
    now: now,
    fromDate: fromDate,
    data: data,
    insights: insights,
    stats: stats,
    failedUnits: failedUnits
  };

  var sent = sendCombinedEmail(result);
  // sendCombinedEmail이 반환했다는 것은 쿼터 사전검사와 모든 배치 시도가 끝났다는 뜻이다.
  // 이후 시트/옵시디안 저장 오류 때문에 같은 날짜 메일이 재발송되지 않도록 먼저 키를 기록한다.
  props.setProperty(CLI_LAST_DELIVERY_KEY_PROP, deliveryKey);
  if (sent > 0) {
    try {
      saveAllToSheets(data, now);
    } catch (saveErr) {
      Logger.log('[CLI inbox] 메일 발송 후 시트 저장 실패: ' + saveErr.message);
      notifyAdmin('[주의] CLI 뉴스레터 시트 저장 실패',
        '메일은 발송되었으나 동향DB 저장에 실패했습니다.\n\n오류: ' + saveErr.message);
    }
    saveToObsidian(data, insights, now, fromDate);
  } else {
    Logger.log('[CLI inbox] 발송 성공 수신자 0명 → DB/옵시디안 저장 생략');
  }
  saveResultSnapshot(result);
  logExecution('CLI 정기', sent, stats, 'deliveryKey=' + deliveryKey);

  if (failedUnits.length > 0) {
    notifyAdmin('[주의] Gemini CLI 일부 카테고리 수집 실패',
      failedUnits.map(function(f) {
        return '- ' + f.domainLabel + ' / ' + f.unitLabel + ' — ' + (f.reason || '원인 미상');
      }).join('\n'));
  }

  return { duplicate: false, deliveryKey: deliveryKey, sent: sent, total: stats.total, high: stats.high };
}

/** payload 기본 구조·시각 검증 */
function validateCliPayload_(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('CLI payload가 객체가 아닙니다.');
  if (payload.version !== CLI_PAYLOAD_VERSION) {
    throw new Error('지원하지 않는 CLI payload 버전: ' + payload.version);
  }
  if (!payload.deliveryKey || !/^[a-zA-Z0-9._-]{1,80}$/.test(String(payload.deliveryKey))) {
    throw new Error('deliveryKey 형식이 잘못되었습니다.');
  }
  if (!payload.data || typeof payload.data !== 'object') throw new Error('data가 없습니다.');

  var now = new Date(payload.nowISO);
  var from = new Date(payload.fromISO);
  if (isNaN(now.getTime()) || isNaN(from.getTime())) throw new Error('nowISO/fromISO 시각이 잘못되었습니다.');
  if (from.getTime() >= now.getTime()) throw new Error('fromISO는 nowISO보다 이전이어야 합니다.');
  if (now.getTime() - from.getTime() > 8 * 24 * 60 * 60 * 1000) {
    throw new Error('수집 기간이 8일을 초과합니다.');
  }
  if (Math.abs(Date.now() - now.getTime()) > 7 * 24 * 60 * 60 * 1000) {
    throw new Error('CLI payload 기준 시각이 현재와 7일 이상 차이 납니다.');
  }
}

/** 수신 JSON 문자열 제한·정규화 */
function cliText_(value, maxLen) {
  var s = (value === null || value === undefined) ? '' : String(value).trim();
  return s.length > maxLen ? s.substring(0, maxLen) : s;
}

/** URL은 바로 신뢰하지 않고 __modelUrl로만 넘겨 findSourceUrls()에서 검증한다. */
function cliUrl_(value) {
  var s = cliText_(value, 2048);
  return /^https?:\/\//i.test(s) ? s : '';
}

/** CLI의 공통 스키마 결과를 Apps Script 내부 스키마로 제한·복원 */
function normalizeCliData_(rawData) {
  var out = newEmptyData();
  DOMAINS.forEach(function(domain) {
    domain.units.forEach(function(unit) {
      var src = rawData[domain.key] && rawData[domain.key][unit.key];
      if (!Array.isArray(src)) return;
      out[domain.key][unit.key] = src.slice(0, 12).map(function(it) {
        it = it || {};
        return {
          gubun: cliText_(it.gubun, 100),
          importance: _imp(cliText_(it.importance, 10)),
          title: cliText_(it.title, 300),
          titleEn: cliText_(it.titleEn, 500),
          summary: cliText_(it.summary, 3000),
          announcedDate: cliText_(it.announcedDate, 20),
          effectiveDate: cliText_(it.effectiveDate, 40),
          hsCode: cliText_(it.hsCode, 300),
          issuingCountry: cliText_(it.issuingCountry, 300),
          targetCountries: cliText_(it.targetCountries, 500),
          agency: cliText_(it.agency, 500),
          sourceName: cliText_(it.sourceName, 300),
          importanceReason: cliText_(it.importanceReason, 1000),
          notes: cliText_(it.notes, 2000),
          __modelUrl: cliUrl_(it.__modelUrl || it.sourceUrl)
        };
      }).filter(function(it) { return !!it.title; });
    });
  });
  return out;
}

/** CLI가 만든 인사이트를 누락 키가 없는 내부 구조로 정리 */
function normalizeCliInsights_(raw) {
  var out = emptyInsights();
  raw = raw || {};
  DOMAINS.forEach(function(domain) {
    var src = raw[domain.key] || {};
    out[domain.key].overall = src.overall === null ? null : cliText_(src.overall, 5000);
    domain.units.forEach(function(unit) {
      var v = src.byCategory && src.byCategory[unit.key];
      out[domain.key].byCategory[unit.key] =
        (v === null || v === undefined || v === '') ? null : cliText_(v, 3000);
    });
  });
  return out;
}

/** 실패 카테고리 알림용 구조 제한 */
function normalizeCliFailedUnits_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 30).map(function(f) {
    f = f || {};
    return {
      domainKey: cliText_(f.domainKey, 50),
      domainLabel: cliText_(f.domainLabel, 100),
      unitKey: cliText_(f.unitKey, 100),
      unitLabel: cliText_(f.unitLabel, 100),
      reason: cliText_(f.reason, 1000)
    };
  });
}

/** 수동 연결 확인: pending 파일 수와 하위 처리 폴더 상태를 로그로 출력 */
function testCliInboxConnection() {
  var folder = getCliInboxFolder_();
  var files = folder.getFiles();
  var count = 0;
  while (files.hasNext()) {
    if (files.next().getName().indexOf(CLI_INBOX_PENDING_PREFIX) === 0) count++;
  }
  Logger.log('[CLI inbox] 폴더 "' + folder.getName() + '" 연결 정상 / pending ' + count + '개');
}
