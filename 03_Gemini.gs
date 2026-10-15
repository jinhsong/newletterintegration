// ============================================================
//  Gemini 호출 (전 도메인·카테고리 병렬) + 재시도 + 응답 파싱
//  API 키는 x-goog-api-key 헤더로 전달 (실행 로그 노출 방지)
// ============================================================

/** 카테고리 1개에 대한 Gemini 검색 요청 객체 생성 (fetchAll 용) */
function buildGeminiRequest(apiKey, domain, unit, ctx) {
  var payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: domain.buildPrompt(unit, ctx) }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.0, maxOutputTokens: 16384 }
  });
  return {
    url: GEMINI_API_BASE + GEMINI_MODEL + ':generateContent',
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: payload,
    muteHttpExceptions: true
  };
}

/**
 * 전 도메인·카테고리(9+5+3=17건)를 한 번의 fetchAll 로 병렬 발사.
 * 실패(503/429)한 건만 추려 지수 백오프로 재시도 (최대 RETRY_MAX 라운드).
 * 끝까지 200을 받지 못한 카테고리는 "동향 없음"과 구분해 failedUnits 로 반환한다
 * (그래야 API 전면 장애가 정상적인 '오늘은 뉴스 없음' 메일로 위장되지 않는다).
 * @returns {{data:Object, failedUnits:Array}} data = { customs:{unit:[]}, ... }
 */
function fetchAllDomainsWithRetry(apiKey, ctx, startMs) {
  var data = newEmptyData();
  var succeeded = {}; // 'domainKey/unitKey' → true
  var reasons = {};   // 'domainKey/unitKey' → 마지막 실패 사유(진단용)

  // 전 도메인·유닛을 펼친 작업 목록
  var pending = [];
  DOMAINS.forEach(function(domain) {
    domain.units.forEach(function(unit) {
      pending.push({ domain: domain, unit: unit });
    });
  });
  var allUnits = pending.slice();

  for (var round = 0; round < RETRY_MAX; round++) {
    if (pending.length === 0) break;
    if (round > 0 && startMs && (Date.now() - startMs) > RETRY_TIME_BUDGET_MS) {
      Logger.log('수집 시간 예산 초과 → 남은 재시도 중단: ' + pending.length + '건');
      break;
    }

    Logger.log('--- [라운드 ' + (round + 1) + '/' + RETRY_MAX + '] ' + pending.length + '개 요청 ---');
    var requests = pending.map(function(t) { return buildGeminiRequest(apiKey, t.domain, t.unit, ctx); });
    // FETCH_CONCURRENCY 단위로 청크를 나눠 발사 → 동시 요청 수를 제한해 레이트 리밋 완화.
    var responses = fetchAllChunked(requests, startMs);

    var stillFailing = [];
    for (var i = 0; i < responses.length; i++) {
      var t = pending[i];
      var resp = responses[i];
      var key = t.domain.key + '/' + t.unit.key;
      var tag = '[' + t.domain.label + '/' + t.unit.key + ']';
      if (!resp) {
        reasons[key] = '네트워크 예외/타임아웃 또는 시간예산 소진';
        Logger.log(tag + ' 응답 없음 → 재시도'); stillFailing.push(t); continue;
      }
      var code = resp.getResponseCode();
      if (code === 200) {
        var pr = parseUnitResponse(t.domain, t.unit, resp.getContentText());
        if (pr.items.length > 0 || !pr.note) {
          // 정상 응답(항목 있음) 또는 정상 빈 결과(finishReason STOP → 진짜 '동향 없음')
          data[t.domain.key][t.unit.key] = pr.items;
          succeeded[key] = true;
          Logger.log(tag + ' 성공: ' + pr.items.length + '건' + (pr.note ? ' (' + pr.note + ')' : ''));
        } else {
          // 200 이지만 안전차단/빈응답/토큰초과 등 → '동향 없음'과 구분해 실패로 기록.
          // 결정적(재시도해도 같은 결과일 가능성 높음)이므로 재시도 큐에 넣지 않는다.
          reasons[key] = 'HTTP 200 · ' + pr.note;
          Logger.log(tag + ' HTTP 200 이나 빈/차단 응답(' + pr.note + ') → 수집 실패 처리');
        }
      } else if (code === 429 || code >= 500) {
        reasons[key] = 'HTTP ' + code + (code === 429 ? ' (레이트 리밋/쿼터)' : ' (서버 오류)');
        Logger.log(tag + ' ' + reasons[key] + ' → 재시도');
        stillFailing.push(t);
      } else {
        reasons[key] = 'HTTP ' + code + ': ' + resp.getContentText().substring(0, 120);
        Logger.log(tag + ' HTTP ' + code + ' (재시도 불가) → 수집 실패 처리');
      }
    }

    pending = stillFailing;
    if (pending.length > 0 && round < RETRY_MAX - 1) {
      var waitMs = RETRY_BASE_MS * Math.pow(2, round);
      if (startMs && (Date.now() - startMs + waitMs) > RETRY_TIME_BUDGET_MS) {
        Logger.log('수집 시간 예산 임박 → 남은 재시도 중단: ' + pending.length + '건');
        break;
      }
      Logger.log(pending.length + '개 재시도 대기 ' + Math.round(waitMs / 1000) + '초');
      Utilities.sleep(waitMs);
    }
  }

  var failedUnits = allUnits
    .filter(function(t) { return !succeeded[t.domain.key + '/' + t.unit.key]; })
    .map(function(t) {
      var key = t.domain.key + '/' + t.unit.key;
      return { domainKey: t.domain.key, domainLabel: t.domain.label, unitKey: t.unit.key, unitLabel: t.unit.label,
        reason: reasons[key] || '재시도 소진 또는 수집 시간 예산 초과' };
    });
  if (failedUnits.length > 0) {
    Logger.log('[수집 실패] ' + failedUnits.length + '개 카테고리 최종 실패: ' +
      failedUnits.map(function(f) { return f.domainLabel + '/' + f.unitLabel + '(' + f.reason + ')'; }).join(', '));
  }

  return { data: data, failedUnits: failedUnits };
}

/**
 * 요청 배열을 FETCH_CONCURRENCY 크기의 청크로 나눠 순차적으로 fetchAll.
 * 동시 발사 수를 제한해 Gemini 레이트 리밋(429)을 완화한다. 각 청크 내부는
 * 여전히 병렬. 시간 예산이 바닥나면 남은 청크는 시도하지 않고 null 로 채운다
 * (상위에서 재시도/실패로 처리).
 */
function fetchAllChunked(requests, startMs) {
  if (requests.length <= FETCH_CONCURRENCY) return safeFetchAll(requests, startMs);
  var out = [];
  for (var s = 0; s < requests.length; s += FETCH_CONCURRENCY) {
    if (s > 0 && startMs && budgetLeftMs(startMs) < FINISH_RESERVE_MS) {
      Logger.log('[fetchAllChunked] 시간 예산 부족 → 잔여 ' + (requests.length - s) + '건 미발송');
      for (var k = s; k < requests.length; k++) out.push(null);
      break;
    }
    var chunk = requests.slice(s, s + FETCH_CONCURRENCY);
    var resps = safeFetchAll(chunk, startMs);
    for (var i = 0; i < resps.length; i++) out.push(resps[i]);
  }
  return out;
}

/**
 * Gemini 응답 본문 → { items, note }.
 * items: 정규화된 공통 항목 배열. note: 항목이 비었을 때의 사유
 *   (안전차단/빈응답/토큰초과 등). finishReason 이 STOP 인 정상 빈 결과는 note='' (진짜 '동향 없음').
 * grounding 출처(__sourceUris)와 모델 제공 URL(__modelUrl)을 부착.
 */
function parseUnitResponse(domain, unit, responseText) {
  var raw = '', gm = null, finishReason = '', blockReason = '';
  try {
    var jr = JSON.parse(responseText);
    if (jr.promptFeedback && jr.promptFeedback.blockReason) blockReason = jr.promptFeedback.blockReason;
    var cand = jr.candidates && jr.candidates[0];
    if (cand) {
      finishReason = cand.finishReason || '';
      if (cand.content && cand.content.parts) {
        cand.content.parts.forEach(function(p) { if (p.text && !p.thought) raw += p.text; });
        if (!raw.trim()) cand.content.parts.forEach(function(p) { if (p.text) raw += p.text; });
      }
      gm = cand.groundingMetadata || null;
    }
  } catch (e) {
    Logger.log('[' + domain.label + '/' + unit.key + '] 응답 봉투 파싱 실패: ' + e.message);
    return { items: [], note: '응답 JSON 파싱 실패' };
  }

  var rawItems = recoverJsonArray(domain.label + '/' + unit.key, raw);
  var items = rawItems.map(function(r) { return domain.normalize(r); })
    .filter(function(it) { return it.title; });
  if (items.length > 0 && gm) attachSources(items, raw, gm);

  var note = '';
  if (items.length === 0) {
    if (blockReason) note = '프롬프트 차단(' + blockReason + ')';
    else if (finishReason && finishReason !== 'STOP') note = 'finishReason=' + finishReason; // SAFETY/RECITATION/MAX_TOKENS 등
    else if (!raw.trim()) note = '빈 응답(후보/텍스트 없음)';
    // finishReason STOP + 정상 빈 배열([]) → note='' → 진짜 '동향 없음'
  }
  return { items: items, note: note };
}

/**
 * 텍스트를 JSON 배열로 파싱 - 4단계 복구.
 * 1. 정상 2. 제어문자 제거 3. 잘린 JSON 복구 4. 개별 객체 추출
 */
function recoverJsonArray(tag, raw) {
  var text = (raw || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  if (!text || text === '[]') return [];

  try {
    var p = JSON.parse(text);
    if (Array.isArray(p)) return p;
  } catch (e1) { /* 복구 진행 */ }

  var cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try {
    var p2 = JSON.parse(cleaned);
    if (Array.isArray(p2)) return p2;
  } catch (e2) { /* 복구 진행 */ }

  var lastBrace = cleaned.lastIndexOf('}');
  if (lastBrace !== -1) {
    var candidate = cleaned.substring(0, lastBrace + 1);
    if (candidate.replace(/^\s+/, '').charAt(0) !== '[') candidate = '[' + candidate;
    candidate += ']';
    try {
      var p3 = JSON.parse(candidate);
      if (Array.isArray(p3) && p3.length > 0) {
        Logger.log('[' + tag + '] 잘린 JSON 복구: ' + p3.length + '건');
        return p3;
      }
    } catch (e3) { /* 개별 추출 진행 */ }
  }

  var items = [];
  var depth = 0, start = -1;
  for (var i = 0; i < cleaned.length; i++) {
    var ch = cleaned.charAt(i);
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          var obj = JSON.parse(cleaned.substring(start, i + 1));
          if (obj && (obj['제목'] || obj.title)) items.push(obj);
        } catch (ignored) { /* 무시 */ }
        start = -1;
      }
    }
  }
  if (items.length > 0) Logger.log('[' + tag + '] 개별 객체 추출: ' + items.length + '건');
  return items;
}


// ============================================================
//  grounding 출처 매핑
//  groundingSupports 의 startIndex 는 UTF-8 바이트 오프셋이므로
//  문자 인덱스 변환 후 항목 제목 위치와 대조
// ============================================================
function attachSources(items, rawText, gm) {
  var chunks = gm.groundingChunks;
  if (!chunks || chunks.length === 0) return;
  var supports = gm.groundingSupports || [];

  // 1차: supports 구간 매핑
  if (supports.length > 0) {
    var anchors = [];
    items.forEach(function(it, idx) {
      var t = it.title || '';
      if (!t) return;
      var p = rawText.indexOf(t);
      if (p >= 0) anchors.push({ pos: p, idx: idx });
    });
    if (anchors.length > 0) {
      anchors.sort(function(a, b) { return a.pos - b.pos; });
      var offs = utf8ByteOffsets(rawText);
      supports.forEach(function(sup) {
        if (!sup.segment || !sup.groundingChunkIndices) return;
        var charStart = byteToCharIndex(offs, sup.segment.startIndex || 0);
        var owner = anchors[0];
        for (var k = 0; k < anchors.length; k++) {
          if (anchors[k].pos <= charStart) owner = anchors[k]; else break;
        }
        var item = items[owner.idx];
        if (!item.__sourceUris) item.__sourceUris = [];
        sup.groundingChunkIndices.forEach(function(ci) {
          var ch = chunks[ci];
          if (ch && ch.web && ch.web.uri && item.__sourceUris.indexOf(ch.web.uri) === -1) {
            item.__sourceUris.push(ch.web.uri);
          }
        });
      });
    }
  }

  // 2차: 출처명 ↔ chunk 도메인 매칭
  items.forEach(function(it) {
    if (it.__sourceUris && it.__sourceUris.length > 0) return;
    var src = normalizeSourceName(it.sourceName);
    if (src.length < 3) return;
    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      if (!(ch && ch.web && ch.web.uri)) continue;
      var dom = normalizeSourceName((ch.web.title || '').split('.')[0]);
      if (dom.length < 3) continue;
      if (src.indexOf(dom) !== -1 || dom.indexOf(src) !== -1) { it.__sourceUris = [ch.web.uri]; break; }
    }
  });

  // 3차: 단일 항목이면 상위 chunk 부착
  if (items.length === 1 && (!items[0].__sourceUris || items[0].__sourceUris.length === 0)) {
    items[0].__sourceUris = chunks
      .filter(function(ch) { return ch && ch.web && ch.web.uri; })
      .slice(0, SOURCES_PER_ITEM)
      .map(function(ch) { return ch.web.uri; });
  }
}

/** UTF-16 문자 인덱스 → UTF-8 바이트 오프셋 테이블 */
function utf8ByteOffsets(str) {
  var offs = new Array(str.length + 1);
  var b = 0, i = 0;
  while (i < str.length) {
    offs[i] = b;
    var c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) { offs[i + 1] = b; b += 4; i += 2; }
    else if (c < 0x80) { b += 1; i++; }
    else if (c < 0x800) { b += 2; i++; }
    else { b += 3; i++; }
  }
  offs[str.length] = b;
  return offs;
}

/** 바이트 오프셋 → 문자 인덱스 (이진 탐색) */
function byteToCharIndex(offs, byteOff) {
  var lo = 0, hi = offs.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (offs[mid] <= byteOff) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * [진단] 수출통제 5개 카테고리를 하나씩 순차 호출하여 실제 HTTP 코드 /
 * finishReason / blockReason / 항목 수를 로그로 출력한다. 수집 실패 원인을
 * 지금 즉시 확인하고 싶을 때 편집기에서 실행. (동시 발사가 아니라 순차라
 * 레이트 리밋이 원인인지도 가늠할 수 있다 — 순차로는 성공하면 동시성 문제.)
 */
function debugExportControl() {
  var apiKey = getApiKey();
  if (!apiKey) { Logger.log('GEMINI_API_KEY 없음'); return; }
  var now = new Date();
  var fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  var ctx = buildPromptContext(now, fromDate);
  var domain = domainByKey('export');

  domain.units.forEach(function(unit) {
    var req = buildGeminiRequest(apiKey, domain, unit, ctx);
    var resp;
    try { resp = UrlFetchApp.fetch(req.url, req); }
    catch (e) { Logger.log('[' + unit.key + '] 네트워크 예외: ' + e.message); return; }
    var code = resp.getResponseCode();
    var body = resp.getContentText();
    var finishReason = '', blockReason = '', nParts = 0;
    try {
      var jr = JSON.parse(body);
      if (jr.promptFeedback) blockReason = jr.promptFeedback.blockReason || '';
      var cand = jr.candidates && jr.candidates[0];
      if (cand) {
        finishReason = cand.finishReason || '';
        nParts = (cand.content && cand.content.parts) ? cand.content.parts.length : 0;
      }
    } catch (e) { /* 파싱 불가 */ }
    var pr = (code === 200) ? parseUnitResponse(domain, unit, body) : { items: [], note: '' };
    Logger.log('[' + unit.label + '(' + unit.key + ')] HTTP ' + code +
      ' / finishReason=' + (finishReason || '-') +
      ' / blockReason=' + (blockReason || '-') +
      ' / parts=' + nParts +
      ' / 항목=' + pr.items.length + (pr.note ? ' / note=' + pr.note : ''));
    if (code !== 200) Logger.log('  본문: ' + body.substring(0, 300));
    Utilities.sleep(1500); // 순차 호출 간 약간의 간격
  });
  Logger.log('=== 수출통제 진단 완료 ===');
}

/** 모델/API 키 헬스체크 (배포 시 1회 실행 권장) */
function verifyModel() {
  var apiKey = getApiKey();
  if (!apiKey) { Logger.log('GEMINI_API_KEY 없음'); return; }
  var resp = UrlFetchApp.fetch(GEMINI_API_BASE + GEMINI_MODEL + ':generateContent', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({ contents: [{ parts: [{ text: 'ping → "pong"만 출력' }] }],
      generationConfig: { maxOutputTokens: 16 } }),
    muteHttpExceptions: true
  });
  Logger.log(resp.getResponseCode() === 200 ? '✅ 모델 정상: ' + GEMINI_MODEL
    : '❌ 실패 HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 400));
}
