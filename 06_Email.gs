// ============================================================
//  단일 통합 HTML 이메일 빌드 (관세 + 수출통제 + 무역구제)
//  테이블 레이아웃 + 인라인 스타일 (Gmail / Outlook / 모바일 호환)
// ============================================================

function esc(t) {
  if (t === null || t === undefined || t === '') return '';
  return t.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 관심영역(focusKey)이 지정되면 해당 도메인을 맨 앞(PART 1)으로 재배열.
 * 수출통제·무역구제 담당자가 자기 섹션을 찾아 스크롤하는 불편을 해소한다.
 * @returns {Array} 재배열된 도메인 배열 (미지정/불명이면 기본 DOMAINS 순서)
 */
function reorderDomains(focusKey) {
  if (!focusKey) return DOMAINS;
  var focus = domainByKey(focusKey);
  if (!focus) return DOMAINS;
  return [focus].concat(DOMAINS.filter(function(d) { return d.key !== focusKey; }));
}

/**
 * @param {Object} data 공통 데이터 구조
 * @param {Object} insights 도메인별 인사이트
 * @param {Date} now 발행 기준 시각
 * @param {Date} fromDate 수집 시작 시각
 * @param {Object} stats computeStats(data, now) 결과 (호출자가 1회 계산해 전달 — 중복 계산 방지)
 * @param {Array} [failedUnits] fetchAllDomainsWithRetry 가 반환한 수집 실패 유닛 목록
 * @param {string} [focusKey] 수신자 관심영역 도메인 key — 지정 시 그 영역을 PART 1로 배치
 */
function buildCombinedEmailHTML(data, insights, now, fromDate, stats, failedUnits, focusKey) {
  var dateStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy년 MM월 dd일 (E)');
  var timeStr = Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
  var fromStr = Utilities.formatDate(fromDate, 'Asia/Seoul', 'MM월 dd일 HH:mm');
  stats = stats || computeStats(data, now);
  var failedByDomain = groupFailedUnitsByDomain(failedUnits);
  var ordered = reorderDomains(focusKey);

  var h = '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background-color:#eef1f5;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f5;">' +
    '<tr><td align="center" style="padding:16px 8px;">' +
    '<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" ' +
    'style="width:680px;max-width:680px;background-color:#ffffff;border:1px solid #dde1e7;font-family:' + FONT_STACK + ';">';

  // ── 헤더 ──
  // 영역별 색 칩(목차 겸 범례): "색 = 영역" 을 학습시켜 본문 경계를 인지하게 함.
  // 칩을 클릭하면 해당 영역 섹션으로 점프(앵커 지원 메일 클라이언트) — 미지원이어도 무해.
  // 순서는 수신자 관심영역(focusKey)에 맞춰 재배열되어, 담당 영역이 맨 앞에 온다.
  var domainChips = ordered.map(function(domain, idx) {
    var dt = stats.byDomain[domain.key];
    var band = domain.palette.band;
    return '<a href="#sec-' + domain.key + '" style="display:inline-block;margin:4px 6px 0 0;padding:4px 11px;border-radius:14px;' +
      'background-color:' + band + ';color:#ffffff;font-size:12px;white-space:nowrap;text-decoration:none;">' +
      (DOMAIN_CIRCLED[idx] || '') + ' ' + esc(domain.label) + ' <b>' + dt.total + '</b></a>';
  }).join('');

  h += '<tr><td bgcolor="#0d1b30" style="padding:26px 28px;background-color:#0d1b30;">' +
    '<div style="font-size:21px;font-weight:bold;color:#ffffff;line-height:1.4;">글로벌 통상 일일 모니터링</div>' +
    '<div style="font-size:12px;color:#9fb4d0;margin-top:5px;">관세 · 수출통제 · 무역구제 통합 브리핑</div>' +
    '<div style="font-size:13px;color:#9fb4d0;margin-top:8px;">' + dateStr + ' &nbsp;|&nbsp; 발행 기준 ' + timeStr + ' KST</div>' +
    '<div style="font-size:12px;color:#7088a8;margin-top:3px;">수집 범위: ' + fromStr + ' ~ ' + timeStr + ' KST</div>' +
    '<div style="margin-top:14px;">' + domainChips + '</div>' +
    '<div style="font-size:12px;color:#ffd54f;margin-top:10px;">합계 <b>' + stats.total + '건</b> · 중요도 상 ' + stats.high + '건</div>' +
    '</td></tr>';

  // ── 수록 기준 안내 ──
  h += '<tr><td bgcolor="#eaf6ee" style="padding:10px 28px;background-color:#eaf6ee;border-top:3px solid #2e8b57;' +
    'font-size:12px;color:#22643c;line-height:1.6;">' +
    '수록 기준: 정부기관 공식 발표·관보 게재·공신력 있는 언론/WTO 문서 기반 확인 정보만 포함 / 미확인·추측성 정보 제외' +
    '</td></tr>';

  // ── 최신성 경고 ──
  if (stats.maxDays !== null && stats.maxDays > STALE_WARN_DAYS) {
    h += '<tr><td bgcolor="#fdecea" style="padding:10px 28px;background-color:#fdecea;border-top:3px solid #c62828;' +
      'font-size:12px;color:#9c2a20;line-height:1.6;">' +
      '⚠ 발표일이 최대 ' + stats.maxDays + '일 경과한 항목이 포함되어 있습니다. 각 항목의 신선도 배지를 확인하세요.' +
      '</td></tr>';
  }

  // ── 수집 실패 경고 (동향 없음과 구분) ──
  if (failedUnits && failedUnits.length > 0) {
    h += '<tr><td bgcolor="#fff3e0" style="padding:10px 28px;background-color:#fff3e0;border-top:3px solid #ef6c00;' +
      'font-size:12px;color:#8a5300;line-height:1.6;">' +
      '⚠ 아래 카테고리는 수집에 실패했습니다(동향이 없는 것과 다름 — 관리자 확인 필요): ' +
      esc(failedUnits.map(function(f) { return f.domainLabel + '/' + f.unitLabel; }).join(', ')) +
      '</td></tr>';
  }

  // ── 오늘의 하이라이트 (전 영역 중요도 '상' 다이제스트, 관심영역 우선 정렬) ──
  h += buildHighlights(data, now, ordered);

  // ── 도메인 섹션 (관심영역이 PART 1) ──
  ordered.forEach(function(domain, idx) {
    h += buildDomainSection(domain, idx, data[domain.key], insights[domain.key], now, stats.byDomain[domain.key], failedByDomain[domain.key]);
  });

  // ── 푸터 ──
  h += '<tr><td bgcolor="#f0f3f7" style="padding:14px 28px;background-color:#f0f3f7;font-size:11px;color:#7a8a9a;' +
    'text-align:center;border-top:1px solid #dde3ea;line-height:1.7;">' +
    '본 메일은 Gemini AI 기반 글로벌 통상(관세·수출통제·무역구제) 통합 자동 모니터링 시스템에 의해 발송되었습니다.<br>' +
    '수집 기준: ' + fromStr + ' ~ ' + timeStr + ' KST &nbsp;|&nbsp; 사용 모델: ' + GEMINI_MODEL +
    '</td></tr>';

  h += '</table></td></tr></table></body></html>';
  return h;
}

/**
 * 오늘의 하이라이트: 전 영역 중요도 '상' 항목을 상단에 모아 한눈에.
 * 스크롤 없이 핵심 파악 → 본문 길이 부담 완화.
 */
function buildHighlights(data, now, ordered) {
  var highs = [];
  (ordered || DOMAINS).forEach(function(domain) {
    domain.units.forEach(function(u) {
      (data[domain.key][u.key] || []).forEach(function(it) {
        if (it.importance === '상') highs.push({ domain: domain, unit: u, it: it });
      });
    });
  });
  if (highs.length === 0) return '';

  var MAX = 6;
  var rows = highs.slice(0, MAX).map(function(hl) {
    var link = getItemLink(hl.it);
    var title = (link && link.isOriginal)
      ? '<a href="' + esc(link.url) + '" target="_blank" style="color:#15418c;text-decoration:underline;font-weight:bold;">' + esc(hl.it.title) + '</a><span style="font-size:11px;color:#8a98a8;">&nbsp;&#8599;</span>'
      : '<b style="color:#1a2a4a;">' + esc(hl.it.title) + '</b>';
    var tag = hl.it.gubun || hl.it.issuingCountry || hl.unit.label;
    return '<div style="margin-top:7px;font-size:13px;line-height:1.6;">' +
      '<span style="display:inline-block;padding:1px 7px;font-size:11px;font-weight:bold;color:#ffffff;' +
      'background-color:' + hl.domain.palette.chip + ';border-radius:3px;white-space:nowrap;">' +
      esc(hl.domain.label) + '</span>&nbsp; ' + title +
      '<span style="font-size:11px;color:#9aa7b4;">&nbsp; · ' + esc(tag) +
      (hl.it.announcedDate ? ' · ' + esc(hl.it.announcedDate) : '') + '</span></div>';
  }).join('');

  return '<tr><td style="padding:16px 28px 18px;background-color:#fff8f8;border-top:3px solid #c62828;border-bottom:1px solid #f0d8d8;">' +
    '<div style="font-size:13px;font-weight:bold;color:#c62828;font-family:' + FONT_STACK + ';">오늘의 하이라이트 · 중요도 상 ' +
    highs.length + '건' + (highs.length > MAX ? ' (상위 ' + MAX + '건 표시)' : '') + '</div>' +
    rows + '</td></tr>';
}

/**
 * 도메인 1개 섹션 (PART 대배너 + 총평 + 카테고리별). idx=0,1,2
 * @param {Object} domainStats stats.byDomain[domain.key] = {total, high} (호출자가 계산해 전달)
 * @param {Array} [failedUnitKeys] 이 도메인에서 수집 실패한 unit.key 목록
 */
function buildDomainSection(domain, idx, domainData, domainInsight, now, domainStats, failedUnitKeys) {
  var pal = domain.palette;
  var dt = domainStats.total, dhi = domainStats.high;
  var failedSet = {};
  (failedUnitKeys || []).forEach(function(k) { failedSet[k] = true; });

  // 영역 사이 큰 여백(중성 배경) — 영역 경계를 시각적으로 끊어줌.
  // 헤더 목차 칩의 점프 대상 앵커를 이 셀 안에 둔다(앵커 미지원 클라이언트에서도 무해).
  var h = '<tr><td bgcolor="#eef1f5" style="background-color:#eef1f5;font-size:0;line-height:0;height:18px;">' +
    '<a name="sec-' + domain.key + '"></a>&nbsp;</td></tr>';

  // 도메인 대배너 (PART N · 영역명) — 왼쪽 굵은 컬러 라인 + 큰 글씨 + 넉넉한 패딩
  h += '<tr><td bgcolor="' + pal.band + '" style="padding:18px 28px;background-color:' + pal.band + ';border-left:8px solid #ffd54f;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="font-family:' + FONT_STACK + ';">' +
    '<div style="font-size:11px;font-weight:bold;color:#ffd54f;letter-spacing:1px;">PART ' + (idx + 1) + '</div>' +
    '<div style="font-size:20px;font-weight:bold;color:#ffffff;line-height:1.3;margin-top:2px;">' +
    (DOMAIN_CIRCLED[idx] || '') + ' ' + esc(domain.label) + ' 동향</div></td>' +
    '<td align="right" style="font-family:' + FONT_STACK + ';font-size:13px;color:#ffffff;white-space:nowrap;">' +
    '<b style="font-size:18px;">' + dt + '</b>건' + (dhi > 0 ? '<br><span style="font-size:11px;color:#ffd9d9;">중요 상 ' + dhi + '건</span>' : '') + '</td>' +
    '</tr></table></td></tr>';

  // 도메인 총평
  if (domainInsight && domainInsight.overall) {
    h += '<tr><td style="padding:14px 28px;background-color:' + pal.catBg + ';border-bottom:1px solid ' + pal.catBg + ';">' +
      '<div style="font-size:12px;font-weight:bold;color:' + pal.catText + ';">총평</div>' +
      '<div style="font-size:13px;color:#3a4a5a;line-height:1.8;margin-top:5px;">' + esc(domainInsight.overall) + '</div>' +
      '</td></tr>';
  }

  // 카테고리(unit) 섹션 — 항목 있는 것만 표시. 빈 카테고리는 하단 한 줄로 묶어 길이 절약.
  // 단, 수집 자체가 실패한 카테고리는 "동향 없음"과 절대 같은 문구로 섞지 않는다.
  var emptyUnits = [];
  var failedUnitLabels = [];
  domain.units.forEach(function(u) {
    var items = domainData[u.key] || [];
    if (items.length === 0) {
      if (failedSet[u.key]) failedUnitLabels.push(u.label); else emptyUnits.push(u.label);
      return;
    }
    var hiCnt = items.filter(function(x) { return x.importance === '상'; }).length;

    h += '<tr><td style="padding:9px 28px 9px 24px;background-color:' + pal.catBg + ';border-left:4px solid ' + pal.catBorder + ';">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td style="font-family:' + FONT_STACK + ';font-size:13px;font-weight:bold;color:' + pal.catText + ';white-space:nowrap;">' +
      esc(u.label) + ' &nbsp;<span style="font-size:11px;font-weight:normal;color:#7c8b9a;">' +
      items.length + '건' + (hiCnt > 0 ? ' · 상 ' + hiCnt : '') + '</span></td>' +
      (u.desc ? '<td align="right" style="font-family:' + FONT_STACK + ';font-size:10px;color:#9aa7b4;line-height:1.5;padding-left:14px;">' +
        esc(u.desc) + '</td>' : '') +
      '</tr></table></td></tr>';

    var ci = domainInsight && domainInsight.byCategory ? domainInsight.byCategory[u.key] : null;
    if (ci) {
      h += '<tr><td style="padding:9px 28px;background-color:#fbfcfe;border-bottom:1px solid #eef1f5;' +
        'font-size:12px;color:#4a5a6a;line-height:1.7;"><b style="color:' + pal.catText + ';">분석</b> &nbsp;' + esc(ci) + '</td></tr>';
    }

    h += '<tr><td style="padding:4px 20px 14px;">';
    sortByImportance(items).forEach(function(it) { h += buildItemCard(it, domain, u, now); });
    h += '</td></tr>';
  });

  // 수집 실패 카테고리 묶음 (동향 없음과 구분되는 주황색 경고)
  if (failedUnitLabels.length > 0) {
    h += '<tr><td style="padding:9px 28px;font-size:11px;color:#a15c00;background-color:#fff8ec;' +
      'border-bottom:1px solid #eef1f5;">⚠ 수집 실패(동향 없음 아님) · ' +
      failedUnitLabels.map(esc).join(', ') + '</td></tr>';
  }

  // 동향 없는 카테고리 묶음 (또는 영역 전체 무동향, 수집 실패분 제외)
  if (emptyUnits.length > 0) {
    var msg = (dt === 0 && failedUnitLabels.length === 0)
      ? '해당 수집 기간 내 확인된 ' + esc(domain.label) + ' 동향이 없습니다.'
      : '동향 없음 · ' + emptyUnits.map(esc).join(', ');
    h += '<tr><td style="padding:9px 28px;font-size:11px;color:#9aa7b4;font-style:italic;' +
      'border-bottom:1px solid #eef1f5;">' + msg + '</td></tr>';
  }

  return h;
}

/** failedUnits 배열([{domainKey,unitKey,...}]) → { domainKey: [unitKey,...] } */
function groupFailedUnitsByDomain(failedUnits) {
  var out = {};
  (failedUnits || []).forEach(function(f) {
    if (!out[f.domainKey]) out[f.domainKey] = [];
    out[f.domainKey].push(f.unitKey);
  });
  return out;
}

/** 항목 카드 (좌측 중요도 컬러 바). domain=소속 영역(색 가족), unit=카테고리 */
function buildItemCard(it, domain, unit, now) {
  var imp = it.importance || '-';
  var impColor = IMPORTANCE_COLORS[imp] || '#90a4ae';
  var impBg = IMPORTANCE_BG[imp] || '#eceff1';

  var badge = function(text, fg, bg, border) {
    return '<span style="display:inline-block;padding:2px 8px;font-size:11px;font-weight:bold;' +
      'color:' + fg + ';background-color:' + bg + ';border:1px solid ' + (border || bg) + ';border-radius:3px;">' +
      esc(text) + '</span>';
  };

  // 분류 배지: 관세 구분 > 발표국가 > 카테고리 라벨. 색은 영역 색으로 통일.
  var catText = it.gubun || it.issuingCountry || unit.label;
  var catColor = domain.palette.chip;

  // 시행일 칩
  var effChip = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test((it.effectiveDate || '').trim())) {
    effChip = '&nbsp;<span style="display:inline-block;padding:2px 8px;font-size:11px;font-weight:bold;' +
      'color:#0b6e6e;background-color:#e0f3f3;border:1px solid #8fcccc;border-radius:3px;">시행 ' + esc(it.effectiveDate) + '</span>';
  }

  var link = getItemLink(it);
  var titleHtml;
  if (link) {
    titleHtml = '<a href="' + esc(link.url) + '" target="_blank" style="color:#15418c;text-decoration:underline;">' +
      esc(it.title) + '</a><span style="font-size:11px;font-weight:normal;color:#8a98a8;">&nbsp; ' +
      (link.isOriginal ? esc(link.label) : 'Google 검색') + ' &#8599;</span>';
  } else {
    titleHtml = esc(it.title);
  }

  var metaPair = function(label, value) {
    return '<span style="white-space:nowrap;"><span style="color:#9aa7b4;">' + label + '</span> ' +
      '<span style="color:#46566a;font-weight:bold;">' + esc(value || '-') + '</span></span>';
  };
  var metaSep = '<span style="color:#cfd8e0;">&nbsp;|&nbsp;</span>';

  // 발표일 + 신선도
  var days = daysSinceKst(it.announcedDate, now || new Date());
  var freshHtml = '';
  if (days !== null) {
    var stale = days > STALE_WARN_DAYS;
    var fColor = stale ? '#c62828' : (days <= 1 ? '#2e7d32' : '#5a6b7a');
    var fBg = stale ? '#fdecea' : (days <= 1 ? '#e8f5e9' : '#eef2f6');
    freshHtml = '&nbsp;<span style="display:inline-block;padding:1px 6px;font-size:10px;font-weight:bold;' +
      'color:' + fColor + ';background-color:' + fBg + ';border-radius:3px;">' +
      esc(freshnessLabel(days)) + (stale ? ' ⚠' : '') + '</span>';
  }
  var dateMeta = '<span style="white-space:nowrap;"><span style="color:#9aa7b4;">발표일</span> ' +
    '<span style="color:#46566a;font-weight:bold;">' + esc(it.announcedDate || '-') + '</span>' + freshHtml + '</span>';

  var metaParts = [dateMeta];
  if ((it.hsCode || '').trim()) metaParts.push(metaPair('HS', it.hsCode));
  if ((it.issuingCountry || '').trim()) metaParts.push(metaPair('발표국가', it.issuingCountry));
  if ((it.targetCountries || '').trim()) metaParts.push(metaPair('대상/영향국', it.targetCountries));
  if ((it.agency || '').trim()) metaParts.push(metaPair('관련기관', it.agency));
  if ((it.sourceName || '').trim()) metaParts.push(metaPair('출처', it.sourceName));

  var notesHtml = (it.notes || '').trim()
    ? '<div style="font-size:11px;color:#8a98a8;font-style:italic;line-height:1.7;margin-top:6px;' +
      'border-left:2px solid #dde3ec;padding-left:9px;">' + esc(it.notes) + '</div>'
    : '';

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="margin-top:12px;border:1px solid #e2e8f0;border-collapse:collapse;"><tr>' +
    '<td width="5" bgcolor="' + impColor + '" style="width:5px;background-color:' + impColor + ';font-size:0;line-height:0;">&nbsp;</td>' +
    '<td style="padding:12px 16px;font-family:' + FONT_STACK + ';">' +
    badge(imp, impColor, impBg, impColor) + '&nbsp;' + badge(catText, '#ffffff', catColor) + effChip +
    '<div style="font-size:14px;font-weight:bold;color:#1a2a4a;line-height:1.6;margin-top:9px;">' + titleHtml + '</div>' +
    '<div style="font-size:13px;color:#46566a;line-height:1.75;margin-top:6px;">' + esc(it.summary) + '</div>' +
    '<div style="font-size:11px;color:#7c8b9a;line-height:1.9;margin-top:10px;">' + metaParts.join(metaSep) + '</div>' +
    notesHtml +
    '</td></tr></table>';
}


// ============================================================
//  발송 (단일 메일 + BCC 분할)
// ============================================================

/** 제목줄 트리아지 접미사 (DOMAINS 반복 — 도메인 추가/변경 시 자동 반영) */
function buildSubjectTriage(stats) {
  if (!stats || !stats.total) return ' · 동향 없음';
  var parts = DOMAINS.map(function(domain) {
    return domain.label + ' ' + stats.byDomain[domain.key].total;
  });
  return ' · ' + parts.join('/') + ' (상 ' + stats.high + ')';
}

/**
 * 발송인 명단으로 발송. 수신자를 관심영역(focus)별로 묶어, 그룹마다 담당 영역이
 * 맨 앞(PART 1)에 오도록 재배열한 HTML 을 BCC 로 보낸다. 수집·정규화는 1회 그대로이고
 * HTML 조립만 그룹 수(최대 도메인 수 + 기본, 4벌)만큼 반복하므로 추가 비용은 미미.
 * @param {Object} result runMonitoringCore 결과 { data, insights, now, fromDate, stats, failedUnits }
 * @returns {number} 발송 성공 인원 수
 */
function sendCombinedEmail(result) {
  var recipients = getRecipients();
  if (recipients.length === 0) {
    Logger.log('[주의] 유효한 수신자 없음');
    notifyAdmin('[주의] 통상 모니터링 발송 대상 없음',
      '발송인 명단에서 유효한 수신자를 찾지 못해 오늘 발송을 건너뛰었습니다.\n' +
      '시트가 비어있는 것이 맞는지, 혹은 일시적인 조회 오류인지 확인해 주세요.');
    return 0;
  }

  var dateStr = Utilities.formatDate(result.now, 'Asia/Seoul', 'yyyy년 MM월 dd일');
  var subject = '[글로벌 통상 모니터링] ' + dateStr + buildSubjectTriage(result.stats);
  var plain = '이 메일은 HTML 형식입니다. HTML 뷰어를 지원하는 메일 클라이언트에서 확인하세요.';

  // 쿼터 확인 — 수신자 수 기준(잔여 쿼터는 "수신자 수" 단위이지 "발송 통 수" 단위가 아니다).
  // 부족하면 부분 발송 대신 전량 중단한다 — 저장은 발송 성공 후에만 이뤄지므로 유실 없음.
  try {
    var quota = MailApp.getRemainingDailyQuota();
    Logger.log('잔여 메일 쿼터: ' + quota + ' / 수신자: ' + recipients.length + '명');
    if (quota < recipients.length) {
      throw new Error('Gmail 일일 발송 쿼터 부족 — 잔여 ' + quota + '건 / 필요 ' + recipients.length + '건');
    }
  } catch (qe) {
    if (/쿼터 부족/.test(qe.message)) throw qe;
    Logger.log('쿼터 조회 실패(계속 진행): ' + qe.message);
  }

  var me = '';
  try { me = Session.getEffectiveUser().getEmail(); } catch (e) { Logger.log('[발송] 발신 계정 조회 실패: ' + e.message); }
  if (!me) me = getAdminEmail();
  if (!me) throw new Error('발신 계정 이메일을 확인할 수 없어 발송을 중단합니다.');

  // 관심영역(focus)별로 수신자 묶기 → 그룹당 HTML 1벌
  var groups = {}; // focusKey('' 포함) → [email,...]
  recipients.forEach(function(r) {
    var f = r.focus || '';
    if (!groups[f]) groups[f] = [];
    groups[f].push(r.email);
  });

  var sent = 0;
  var failures = [];
  Object.keys(groups).forEach(function(focus) {
    var html = buildCombinedEmailHTML(result.data, result.insights, result.now, result.fromDate,
      result.stats, result.failedUnits, focus);
    var emails = groups[focus];
    for (var i = 0; i < emails.length; i += BCC_BATCH_SIZE) {
      var batch = emails.slice(i, i + BCC_BATCH_SIZE);
      try {
        GmailApp.sendEmail(me, subject, plain, { htmlBody: html, bcc: batch.join(','), name: '통상 모니터링 시스템' });
        sent += batch.length;
      } catch (e) {
        failures.push('[' + (focus || '기본') + '] ' + batch.length + '명 배치 실패: ' + e.message);
        Logger.log('발송 실패: ' + e.message);
      }
    }
  });
  Logger.log('발송 결과 - 성공 ' + sent + '명 / 실패 ' + failures.length + '배치 / 그룹 ' + Object.keys(groups).length + '개');

  if (failures.length > 0) {
    notifyAdmin('[주의] 통상 뉴스레터 일부 발송 실패 (' + dateStr + ')',
      '성공 ' + sent + '명\n' + failures.join('\n'));
  }
  return sent;
}
