// ============================================================
//  AI 인사이트 (도메인별 전체 총평 + 카테고리별 분석)
//  3개 도메인 요청을 한 번의 fetchAll 로 병렬 생성
//  insights = { customs:{overall, byCategory:{unit:..}}, export:{...}, trade:{...} }
// ============================================================

/** 전 도메인 null 인사이트 */
function emptyInsights() {
  var out = {};
  DOMAINS.forEach(function(domain) {
    var by = {};
    domain.units.forEach(function(u) { by[u.key] = null; });
    out[domain.key] = { overall: null, byCategory: by };
  });
  return out;
}

function generateAllInsights(apiKey, data, startMs) {
  var out = emptyInsights();

  // 데이터 있는 도메인만 요청 대상으로
  var jobs = [];
  DOMAINS.forEach(function(domain) {
    var has = domain.units.some(function(u) { return (data[domain.key][u.key] || []).length > 0; });
    if (has) jobs.push(domain);
    else out[domain.key].overall = '금일 수집 기간 내 확인된 ' + domain.label + ' 동향이 없습니다.';
  });
  if (jobs.length === 0) return out;

  var requests = jobs.map(function(domain) {
    return {
      url: GEMINI_API_BASE + GEMINI_MODEL + ':generateContent',
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildInsightPrompt(domain, data) }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
      }),
      muteHttpExceptions: true
    };
  });

  var resps = safeFetchAll(requests, startMs);
  for (var i = 0; i < jobs.length; i++) {
    var domain = jobs[i];
    var resp = resps[i];
    if (!resp || resp.getResponseCode() !== 200) {
      Logger.log('[인사이트/' + domain.label + '] 실패 HTTP ' + (resp ? resp.getResponseCode() : 'null'));
      continue;
    }
    try {
      var jr = JSON.parse(resp.getContentText());
      var text = '';
      if (jr.candidates && jr.candidates[0] && jr.candidates[0].content) {
        jr.candidates[0].content.parts.forEach(function(p) { if (p.text) text += p.text; });
      }
      text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      out[domain.key] = parseInsightsWithRecovery(domain, text);
    } catch (e) {
      Logger.log('[인사이트/' + domain.label + '] 파싱 오류: ' + e.message);
    }
  }
  return out;
}

function buildInsightPrompt(domain, data) {
  // 토큰 절약: 빈 카테고리 제외, 요약 150자 절단
  // 발표국가(issuingCountry)는 무역구제 도메인 스키마에 없어 항상 빈 문자열이므로,
  // 실제 조치 주체를 담고 있는 관련기관(agency, 예: USTR/MOFCOM)을 항상 함께 전달한다.
  // 이게 없으면 모델이 '데이터 외 추측 금지' 규칙 아래 국가를 특정하지 못해
  // 총평/분석이 공허해지거나(무역구제) 오히려 추측성 국가를 지어낼 위험이 있었다.
  var summary = {};
  domain.units.forEach(function(u) {
    var arr = (data[domain.key][u.key] || []).map(function(it) {
      var c = it.summary || '';
      if (c.length > 150) c = c.substring(0, 150) + '…';
      return { 제목: it.title, 요약: c, 중요도: it.importance,
        발표국가: it.issuingCountry, 영향국가: it.targetCountries, 관련기관: it.agency };
    });
    if (arr.length > 0) summary[u.key] = arr;
  });

  var unitKeys = domain.units.map(function(u) { return u.key; });
  var byCat = unitKeys.map(function(k) { return '"' + k + '":"인사이트 2~3문장 또는 null"'; }).join(',');

  return '다음은 오늘 수집된 글로벌 ' + domain.label + ' 동향입니다 ' +
    '(사실 확인된 정보, 동향 없는 카테고리는 생략됨):\n\n' +
    JSON.stringify(summary) + '\n\n' +
    '위 데이터에 근거하여 전문가 인사이트를 작성하십시오.\n' +
    '규칙: 데이터 외 추측 금지. 이모지 금지. 순수 JSON만 출력.\n' +
    '카테고리 전체 목록: ' + unitKeys.join(', ') + ' (데이터 없는 카테고리는 null)\n\n' +
    '{"overall":"전체 총평 3~5문장. 가장 중요한 이슈 중심, 기업 주목 포인트 제시.",' +
    '"byCategory":{' + byCat + '}}';
}

/** 인사이트 JSON 파싱 + 4단계 복구 */
function parseInsightsWithRecovery(domain, text) {
  var makeFallback = function() {
    var by = {};
    domain.units.forEach(function(u) { by[u.key] = null; });
    return { overall: null, byCategory: by };
  };
  if (!text) return makeFallback();

  try {
    var p1 = JSON.parse(text);
    if (p1 && p1.overall !== undefined) return normalizeInsight(domain, p1);
  } catch (e1) { /* 복구 진행 */ }

  var cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try {
    var p2 = JSON.parse(cleaned);
    if (p2 && p2.overall !== undefined) return normalizeInsight(domain, p2);
  } catch (e2) { /* 복구 진행 */ }

  var lastQuote = cleaned.lastIndexOf('"');
  var lastNull = cleaned.lastIndexOf('null');
  var cutPoint = Math.max(lastQuote, lastNull + 3);
  if (cutPoint > 0) {
    var candidate = cleaned.substring(0, cutPoint + 1).replace(/,\s*$/, '') + '}}';
    try {
      var p3 = JSON.parse(candidate);
      if (p3 && (p3.overall !== undefined || p3.byCategory)) return normalizeInsight(domain, p3);
    } catch (e3) { /* 개별 추출 진행 */ }
  }

  // 정규식 개별 추출
  var result = makeFallback();
  var om = cleaned.match(/"overall"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (om) result.overall = om[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
  domain.units.forEach(function(u) {
    var esc = u.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (cleaned.match(new RegExp('"' + esc + '"\\s*:\\s*null'))) { result.byCategory[u.key] = null; return; }
    var sm = cleaned.match(new RegExp('"' + esc + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
    if (sm) result.byCategory[u.key] = sm[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
  });
  return result;
}

/** byCategory 누락 키 null 보강 */
function normalizeInsight(domain, p) {
  if (!p.byCategory) p.byCategory = {};
  domain.units.forEach(function(u) { if (p.byCategory[u.key] === undefined) p.byCategory[u.key] = null; });
  return p;
}
