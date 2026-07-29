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

  // CLI 모드에서는 로컬 Gemini CLI가 수집한 Drive inbox 파일만 처리한다.
  // 예전에 등록된 API 정기 트리거가 남아 있어도 Gemini API를 호출하지 않도록 방어.
  if (e && typeof isCliRuntime_ === 'function' && isCliRuntime_()) {
    Logger.log('Gemini CLI 모드 → API 정기 모니터링 트리거 생략');
    return;
  }

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
    var sent = sendCombinedEmail(result);

    // 저장은 발송 성공(1건 이상 발송) 후에만 수행한다 — 발송이 실패했는데
    // 먼저 저장해 버리면, 다음 실행의 7일 중복제거 이력에 걸려 그 항목들은
    // 영원히 재발송되지 못한다 (수출통제 원본 시스템의 "발송 후 저장" 원칙 복원).
    if (sent > 0) {
      try {
        saveAllToSheets(result.data, result.now);
      } catch (saveErr) {
        Logger.log('[저장 오류] 시트 저장 실패: ' + saveErr.message);
        notifyAdmin('[주의] 통상 모니터링 시트 저장 실패',
          '이메일은 정상 발송되었으나 동향DB 저장에 실패했습니다.\n' +
          '다음 실행의 중복 제거 이력에서 누락될 수 있습니다.\n\n오류: ' + saveErr.message);
      }
      // 옵시디안 저장은 개인 아카이브 목적이라 실패해도 발송/시트 저장에 영향 없음(내부적으로 이미 try/catch)
      saveToObsidian(result.data, result.insights, result.now, result.fromDate);
    } else {
      Logger.log('[주의] 발송 대상 0건 → 저장 생략 (다음 실행에서 재수집)');
    }

    // 수집 실패 카테고리가 있으면 "동향 없음"과 구분해 관리자에게 알림 (사유 포함)
    if (result.failedUnits && result.failedUnits.length > 0) {
      notifyAdmin('[주의] 통상 모니터링 일부 카테고리 수집 실패',
        '아래 카테고리는 수집에 실패하여 "동향 없음"으로 표시되었을 수 있습니다.\n' +
        '사유가 HTTP 429 계열이면 동시 요청이 많아 레이트 리밋에 걸린 것이므로 ' +
        'FETCH_CONCURRENCY 값을 낮추거나 API 등급을 확인하고, finishReason=SAFETY/RECITATION ' +
        '이면 해당 주제가 안전필터에 걸린 것입니다.\n\n' +
        result.failedUnits.map(function(f) {
          return '- ' + f.domainLabel + ' / ' + f.unitLabel + ' — ' + (f.reason || '원인 미상');
        }).join('\n'));
    }

    // 발송 결과 스냅샷 저장 → resendLastBriefing() 이 재수집 없이 그대로 재발송할 수 있게.
    // (수신자 0명이라 sent=0 이어도, 명단 보완 후 재전송할 수 있도록 저장해 둔다.)
    saveResultSnapshot(result);

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
 * 재전송: 직전에 발송한 브리핑을 재수집 없이 그대로 다시 발송한다.
 * 발송 실패분 보완, 뒤늦게 추가된 수신자 대상 재전송 등에 사용. 저장된 스냅샷을
 * 재생하므로 오늘 내용이 그대로 유지되고(재수집 시 중복제거로 빈 결과가 되는 문제 없음),
 * 관심영역 순서도 각 수신자에 맞춰 다시 적용된다.
 * @param {string} [toEmails] 특정 수신자에게만 재전송 (쉼표/공백 구분). 생략 시 현재 명단 전체.
 */
function resendLastBriefing(toEmails) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(60000)) { Logger.log('[재전송] 잠금 실패 → 다른 실행 진행 중'); return; }
  try {
    var result = loadResultSnapshot();
    if (!result) {
      Logger.log('[재전송] 저장된 스냅샷 없음');
      notifyAdmin('[재전송 불가] 스냅샷 없음',
        '재전송할 직전 발송 내역이 없습니다. runMonitoringNow() 로 새로 발송하세요.');
      return;
    }

    var override = null;
    if (toEmails && toEmails.toString().trim()) {
      var focusMap = {};
      getRecipients().forEach(function(r) { focusMap[r.email.toLowerCase()] = r.focus; });
      override = toEmails.toString().split(/[,;\s]+/)
        .map(function(e) { return e.trim(); })
        .filter(function(e) { return e.indexOf('@') !== -1; })
        .map(function(e) { return { name: '', email: e, focus: focusMap[e.toLowerCase()] || '' }; });
      if (override.length === 0) { Logger.log('[재전송] 유효한 수신자 지정 없음'); return; }
    }

    var sent = sendCombinedEmail(result, override);
    logExecution('재전송', sent, result.stats, override ? ('지정 ' + override.length + '명') : '명단 전체');
    Logger.log('[재전송] 완료 — ' + sent + '명 (' +
      Utilities.formatDate(result.now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' 발송분)');
  } catch (e) {
    Logger.log('[재전송] 오류: ' + e.message);
    notifyAdmin('[재전송 오류]', e.message + '\n\n' + (e.stack || ''));
  } finally {
    lock.releaseLock();
  }
}

/**
 * 수집 → 발송용 HTML 빌드까지의 공통 파이프라인 (정기/요청 공용).
 * 저장(시트/옵시디안)은 이 함수가 하지 않는다 — 호출자가 발송 성공을 확인한
 * 뒤에 저장해야 "발송 실패 시 항목이 중복제거 이력에 걸려 영구 유실"되는
 * 사고를 막을 수 있다 (runDailyMonitoring 참조).
 * @param {Object} [opts] {startMs, dedupe}
 *   dedupe=false 면 동향DB 이력 대비 중복 제거를 생략하고 "현재 전체 현황"을 반환한다.
 *   온디맨드 요청/재전송처럼 지금 이 시점의 전체를 원할 때 사용 (정기 발송분이 이미
 *   DB에 저장돼 있어 중복제거하면 빈 결과가 되는 것을 방지).
 * @returns {Object} { html, now, fromDate, data, insights, stats, failedUnits }
 */
function runMonitoringCore(opts) {
  opts = opts || {};
  var startMs = opts.startMs || Date.now();
  var apiKey = getApiKey();
  if (!apiKey) throw new Error('스크립트 속성에 GEMINI_API_KEY 가 설정되지 않았습니다.');

  var now = new Date();
  var lookbackH = lookbackHoursFor(now);
  var fromDate = new Date(now.getTime() - lookbackH * 60 * 60 * 1000);
  var ctx = buildPromptContext(now, fromDate);

  Logger.log('=== 통상 통합 모니터링 시작 ===');
  Logger.log('기준: ' + ctx.toStr + ' KST / 소급 ' + lookbackH + 'h / 모델 ' + GEMINI_MODEL);

  // 1. 전 도메인·카테고리 병렬 수집 (재시도 포함)
  var fetchResult = fetchAllDomainsWithRetry(apiKey, ctx, startMs);
  var data = fetchResult.data;
  var failedUnits = fetchResult.failedUnits; // [{domainKey,domainLabel,unitKey,unitLabel}]

  // 2. 발표일 기준 날짜 필터 (2차 안전장치)
  forEachUnit(data, function(domain, unit, items, setItems) {
    var kept = filterByDate(items, ctx.fromISO, ctx.toISO);
    if (kept.length !== items.length) {
      Logger.log('[' + domain.label + '/' + unit.key + '] 날짜 필터 제거: ' + (items.length - kept.length) + '건');
    }
    setItems(kept);
  });

  // 3. 중복 제거 (동향DB 이력 대비) — dedupe=false(온디맨드/재전송)면 생략해 전체 현황 유지
  if (opts.dedupe !== false) {
    DOMAINS.forEach(function(domain) {
      var history = loadRecentTitles(domain, DEDUPE_LOOKBACK_DAYS, fromDate);
      dedupeDomain(data[domain.key], history);
    });
  } else {
    Logger.log('[중복] DB 이력 대비 중복 제거 생략 (전체 현황 요청)');
  }

  // 3-1. 교차 영역 중복 제거 (같은 메일 안에서 관세↔전문영역 중복 방지) — 항상 수행
  removeCrossDomainOverlap(data);

  // 4. 원문 URL 확보 (grounding → 모델 URL 검증 → 뉴스 RSS → 검색 링크 폴백)
  findSourceUrls(data, startMs);

  // 4-1. 객관적 발행일(RSS pubDate) 기반 최신성 재검증 — 모델 자기보고 날짜 환각 방어
  enforceRecency(data, fromDate);

  // 5. AI 인사이트 (도메인별, 시간 예산 부족 시 생략)
  var insights;
  if (budgetLeftMs(startMs) < FINISH_RESERVE_MS + 60000) {
    Logger.log('[시간예산] 부족 → 인사이트 생략');
    insights = emptyInsights();
  } else {
    Logger.log('인사이트 생성 중...');
    insights = generateAllInsights(apiKey, data, startMs);
  }

  // 6. 통계 + 단일 HTML
  var stats = computeStats(data, now);
  var html = buildCombinedEmailHTML(data, insights, now, fromDate, stats, failedUnits);
  return { html: html, now: now, fromDate: fromDate, data: data, insights: insights, stats: stats, failedUnits: failedUnits };
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
//  두 질문(주말인가? / 소급 시간은 몇 시간인가?)을 별도 함수로 분리한다.
//  과거에는 lookback=0 을 "주말이라 발송 안 함" 센티널로 겸용했는데,
//  온디맨드 요청(주말에도 응답해야 함)이 이를 `|| 24` 로 재해석해야 했고,
//  두 정책이 뒤섞여 있어 한쪽만 바꾸면 다른 쪽이 조용히 깨지는 구조였다.
// ============================================================

/** KST 기준 토·일 여부 */
function isWeekendKst(now) {
  var dow = parseInt(Utilities.formatDate(now, 'Asia/Seoul', 'u'), 10); // 1=월…7=일
  return dow === 6 || dow === 7;
}

/** 소급 시간(시간): 월 72h(주말 커버), 화~금 24h, 토·일도 24h(온디맨드 요청용). */
function lookbackHoursFor(now) {
  var dow = parseInt(Utilities.formatDate(now, 'Asia/Seoul', 'u'), 10);
  if (dow === 1) return 72;
  return 24;
}

/** 주말 자동 실행 건너뜀 판정 (자동 트리거 e 존재 + 주말이면 true). */
function shouldSkipWeekendRun(e, now) {
  var triggered = (e !== undefined && e !== null);
  return triggered && isWeekendKst(now);
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
