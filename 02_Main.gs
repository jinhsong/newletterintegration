// ============================================================
//  메인 오케스트레이션 (수집 → 정규화 → 중복제거 → 출처 → 인사이트
//                       → 저장 → 단일 HTML → 1회 발송)
// ============================================================

/**
 * 정기 발송 진입점 (평일 09시 트리거).
 * @param {*} e 트리거 이벤트(자동 실행) 또는 undefined(수동 실행)
 */
function runDailyMonitoring(e) {
  var startMs = Date.now();

  // 주말 자동 실행만 차단. 수동 실행(e 없음)은 주말에도 테스트 가능.
  if (shouldSkipWeekendRun(e, new Date())) {
    Logger.log('주말 자동 실행 → 정기 모니터링 생략');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_DAILY_MS)) {
    Logger.log('다른 실행이 잠금 점유 중 → 정기 실행 중단');
    notifyAdmin('[주의] 통상 통합 모니터링 정기 실행 건너뜀',
      '다른 실행이 잠금을 점유하여 정기 실행을 건너뛰었습니다. runMonitoringNow() 를 수동 실행해 주세요.');
    return;
  }
  try {
    var result = runMonitoringCore({ startMs: startMs });
    Logger.log('이메일 발송 중...');
    var sent = sendCombinedEmail(result.html, result.now, result.stats);
    logExecution('정기', sent, result.stats, '');
    Logger.log('=== 통합 모니터링 완료 ===');
  } catch (err) {
    Logger.log('치명적 오류: ' + err.message);
    notifyAdmin('[오류] 통상 통합 모니터링 실패', '오류:\n' + err.message + '\n\n' + (err.stack || ''));
  } finally {
    lock.releaseLock();
  }
}

/** 즉시 강제 실행 (요일·트리거 무관). 주말 테스트·긴급 발송용. */
function runMonitoringNow() {
  return runDailyMonitoring();
}

/**
 * 수집 → 발송 직전까지의 공통 파이프라인 (정기/요청 공용).
 * @param {Object} [opts] {skipSave, startMs}
 * @returns {Object} { html, now, fromDate, data, insights, stats }
 */
function runMonitoringCore(opts) {
  opts = opts || {};
  var startMs = opts.startMs || Date.now();
  var apiKey = getApiKey();
  if (!apiKey) throw new Error('스크립트 속성에 GEMINI_API_KEY 가 설정되지 않았습니다.');

  var now = new Date();
  var lookbackH = monitoringLookbackHours(now) || 24; // 주말 요청은 24h
  var fromDate = new Date(now.getTime() - lookbackH * 60 * 60 * 1000);
  var ctx = buildPromptContext(now, fromDate);

  Logger.log('=== 통상 통합 모니터링 시작 ===');
  Logger.log('기준: ' + ctx.toStr + ' KST / 소급 ' + lookbackH + 'h / 모델 ' + GEMINI_MODEL);

  // 1. 전 도메인·카테고리 병렬 수집 (재시도 포함)
  var data = fetchAllDomainsWithRetry(apiKey, ctx, startMs);

  // 2. 발표일 기준 날짜 필터 (2차 안전장치)
  forEachUnit(data, function(domain, unit, items, setItems) {
    var kept = filterByDate(items, ctx.fromISO, ctx.toISO);
    if (kept.length !== items.length) {
      Logger.log('[' + domain.label + '/' + unit.key + '] 날짜 필터 제거: ' + (items.length - kept.length) + '건');
    }
    setItems(kept);
  });

  // 3. 중복 제거 (도메인별 DB 최근 7일 + 런 내)
  DOMAINS.forEach(function(domain) {
    var history = loadRecentTitles(domain, DEDUPE_LOOKBACK_DAYS, fromDate);
    dedupeDomain(data[domain.key], history);
  });

  // 4. 원문 URL 확보 (grounding → 모델 URL 검증 → 뉴스 RSS → 검색 링크 폴백)
  findSourceUrls(data, startMs);

  // 5. AI 인사이트 (도메인별, 시간 예산 부족 시 생략)
  var insights;
  if (budgetLeftMs(startMs) < FINISH_RESERVE_MS + 30000) {
    Logger.log('[시간예산] 부족 → 인사이트 생략');
    insights = emptyInsights();
  } else {
    Logger.log('인사이트 생성 중...');
    insights = generateAllInsights(apiKey, data, startMs);
  }

  // 6. 저장 (요청 발송 시 생략)
  if (opts.skipSave) {
    Logger.log('skipSave → 시트/옵시디안 저장 생략');
  } else {
    Logger.log('시트 저장 중...');
    saveAllToSheets(data, now);
    saveToObsidian(data, insights, now, fromDate);
  }

  // 7. 통계 + 단일 HTML
  var stats = computeStats(data, now);
  var html = buildCombinedEmailHTML(data, insights, now, fromDate);
  return { html: html, now: now, fromDate: fromDate, data: data, insights: insights, stats: stats };
}


// ============================================================
//  공통 데이터 구조 헬퍼
// ============================================================

/** 빈 결과 구조 생성: { customs:{unit:[]}, export:{...}, trade:{...} } */
function newEmptyData() {
  var d = {};
  DOMAINS.forEach(function(domain) {
    d[domain.key] = {};
    domain.units.forEach(function(u) { d[domain.key][u.key] = []; });
  });
  return d;
}

/** 모든 도메인의 모든 항목 순회 */
function forEachItem(data, fn) {
  DOMAINS.forEach(function(domain) {
    domain.units.forEach(function(u) {
      (data[domain.key][u.key] || []).forEach(function(it) { fn(it, domain, u); });
    });
  });
}

/** 모든 도메인의 (도메인,유닛,항목배열) 단위 순회. setItems 로 교체 가능. */
function forEachUnit(data, fn) {
  DOMAINS.forEach(function(domain) {
    domain.units.forEach(function(u) {
      var items = data[domain.key][u.key] || [];
      fn(domain, u, items, function(next) { data[domain.key][u.key] = next; });
    });
  });
}


// ============================================================
//  발송 정책 (주말/소급 시간)
// ============================================================

/** 소급 시간: 월 72h, 화~금 24h, 주말 0(발송 안 함). KST 요일 기준. */
function monitoringLookbackHours(now) {
  var dow = parseInt(Utilities.formatDate(now, 'Asia/Seoul', 'u'), 10); // 1=월…7=일
  if (dow === 6 || dow === 7) return 0;
  if (dow === 1) return 72;
  return 24;
}

/** 주말 자동 실행 건너뜀 판정 (자동 트리거 e 존재 + 주말이면 true). */
function shouldSkipWeekendRun(e, now) {
  var triggered = (e !== undefined && e !== null);
  return triggered && monitoringLookbackHours(now) === 0;
}

/** 프롬프트 컨텍스트(날짜 문자열) 생성 */
function buildPromptContext(now, fromDate) {
  return {
    now: now,
    fromDate: fromDate,
    fromStr: Utilities.formatDate(fromDate, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
    toStr: Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
    fromISO: Utilities.formatDate(fromDate, 'Asia/Seoul', 'yyyy-MM-dd'),
    toISO: Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd')
  };
}


// ============================================================
//  통계 / 시간 예산 / 관리자 알림
// ============================================================

/** 전역 시간 예산 잔여(ms). startMs 없으면 무제한. */
function budgetLeftMs(startMs) {
  if (!startMs) return Infinity;
  return TOTAL_TIME_BUDGET_MS - (Date.now() - startMs);
}

/** 도메인별/전체 통계 */
function computeStats(data, now) {
  var ref = now || new Date();
  var stats = { total: 0, high: 0, maxDays: null, byDomain: {} };
  DOMAINS.forEach(function(domain) {
    var dt = { total: 0, high: 0 };
    domain.units.forEach(function(u) {
      (data[domain.key][u.key] || []).forEach(function(it) {
        dt.total++; stats.total++;
        if (it.importance === '상') { dt.high++; stats.high++; }
        var d = daysSinceKst(it.announcedDate, ref);
        if (d !== null && (stats.maxDays === null || d > stats.maxDays)) stats.maxDays = d;
      });
    });
    stats.byDomain[domain.key] = dt;
  });
  return stats;
}

function getApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

function getAdminEmail() {
  var a = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
  if (a) return a;
  try { return Session.getEffectiveUser().getEmail(); } catch (e) { return ''; }
}

function notifyAdmin(subject, body) {
  try {
    var admin = getAdminEmail();
    if (!admin) { Logger.log('[알림] 관리자 이메일 없음: ' + subject); return; }
    MailApp.sendEmail({ to: admin, subject: subject, body: body });
  } catch (e) { Logger.log('[notifyAdmin] 실패: ' + e.message); }
}


// ============================================================
//  날짜 필터 (2차 안전장치)
// ============================================================
function filterByDate(items, fromISO, toISO) {
  return items.filter(function(it) {
    var d = it.announcedDate;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    if (d < fromISO || d > toISO) return false;
    return true;
  });
}

/** 발표일(YYYY-MM-DD, KST)과 기준 시각 사이 경과 일수. 형식 오류면 null. */
function daysSinceKst(dateStr, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  var todayStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
  var a = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  var b = Date.UTC(+todayStr.slice(0, 4), +todayStr.slice(5, 7) - 1, +todayStr.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

function freshnessLabel(days) {
  if (days === null || days === undefined) return '';
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  return days + '일 전';
}

/** 중요도(상→중→하) 1차, 발표일(최신 우선) 2차 정렬 (원본 불변). */
function sortByImportance(items) {
  return items.slice().sort(function(a, b) {
    var oa = IMPORTANCE_ORDER[a.importance] !== undefined ? IMPORTANCE_ORDER[a.importance] : 3;
    var ob = IMPORTANCE_ORDER[b.importance] !== undefined ? IMPORTANCE_ORDER[b.importance] : 3;
    if (oa !== ob) return oa - ob;
    var da = a.announcedDate || '', db = b.announcedDate || '';
    return da < db ? 1 : (da > db ? -1 : 0);
  });
}
