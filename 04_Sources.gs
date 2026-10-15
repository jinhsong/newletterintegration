// ============================================================
//  원문 URL 확보 파이프라인 (4단계 폴백) — 전 도메인 항목 공용
//  1) groundingMetadata 리다이렉트 해소
//  2) 모델 제공 URL 접속 검증
//  3) Bing 뉴스 RSS 제목 검색 매칭
//  4) (렌더링 시) Google 검색 링크 — getItemLink
// ============================================================
function findSourceUrls(data, startMs) {
  // 1단계도 다른 단계와 동일하게 최소 예산을 요구한다 — 무조건 실행하면
  // 수집 라운드가 이미 예산을 많이 소모한 날 그대로 발송을 지연시킬 수 있다.
  if (budgetLeftMs(startMs) > FINISH_RESERVE_MS + SOURCE_STAGE_MIN_MS) {
    resolveGroundingUrls(data, startMs); // 1단계
  } else { Logger.log('[출처 1] 시간 예산 부족 → 생략 (검색 링크 폴백)'); }

  if (budgetLeftMs(startMs) > FINISH_RESERVE_MS + SOURCE_STAGE_MIN_MS) {
    validateModelUrls(data, startMs); // 2단계
  } else { Logger.log('[출처 2] 시간 예산 부족 → 생략'); }

  if (budgetLeftMs(startMs) > FINISH_RESERVE_MS + SOURCE_STAGE_MIN_MS) {
    searchNewsRss(data, startMs); // 3단계
  } else { Logger.log('[출처 3] 시간 예산 부족 → 생략'); }

  var withUrl = 0, total = 0;
  forEachItem(data, function(it) { total++; if (it.sourceUrl) withUrl++; });
  Logger.log('[출처] 최종 원문 링크 ' + withUrl + '/' + total + '건 (나머지 검색 링크 폴백)');
}

/**
 * fetchAll 일괄 실패 시 개별 fetch 폴백 (네트워크 예외 방어).
 * startMs 를 넘기면, 순차 폴백 도중 시간 예산이 바닥나는 즉시 남은 요청은
 * 시도하지 않고 null 로 채운다 — 그렇지 않으면 17건 그라운딩 호출 같은
 * 무거운 요청이 순차 재시도로 전환될 때 6분 제한을 그대로 넘겨버린다.
 */
function safeFetchAll(requests, startMs) {
  var out = new Array(requests.length);
  try {
    var resps = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < resps.length; i++) out[i] = resps[i];
    return out;
  } catch (e) {
    Logger.log('[safeFetchAll] 일괄 실패 (' + e.message + ') → 개별 재시도');
  }
  for (var j = 0; j < requests.length; j++) {
    if (startMs && budgetLeftMs(startMs) <= 0) {
      Logger.log('[safeFetchAll] 시간 예산 소진 → 잔여 ' + (requests.length - j) + '건 순차 재시도 중단');
      break; // 나머지는 out[j..] = undefined → 호출부에서 null 과 동일하게 처리됨
    }
    try { out[j] = UrlFetchApp.fetch(requests[j].url, requests[j]); } catch (e2) { out[j] = null; }
  }
  return out;
}

/** [1단계] grounding 리다이렉트 URL → Location 헤더로 원문 URL 해소 */
function resolveGroundingUrls(data, startMs) {
  var uriSet = {};
  forEachItem(data, function(it) {
    (it.__sourceUris || []).slice(0, SOURCES_PER_ITEM).forEach(function(u) { uriSet[u] = true; });
  });
  var uris = Object.keys(uriSet);
  if (uris.length === 0) { Logger.log('[출처 1] grounding 출처 없음'); return; }

  Logger.log('[출처 1] 리다이렉트 해소: ' + uris.length + '건');
  var resolved = {};
  for (var s = 0; s < uris.length; s += RESOLVE_BATCH_SIZE) {
    if (s > 0 && budgetLeftMs(startMs) < FINISH_RESERVE_MS) {
      Logger.log('[출처 1] 시간 예산 부족 → 잔여 ' + (uris.length - s) + '건 생략'); break;
    }
    var batch = uris.slice(s, s + RESOLVE_BATCH_SIZE);
    var resps = safeFetchAll(batch.map(function(u) {
      return { url: u, method: 'get', followRedirects: false, muteHttpExceptions: true };
    }), startMs);
    for (var i = 0; i < resps.length; i++) {
      if (!resps[i]) continue;
      var code = resps[i].getResponseCode();
      var headers = resps[i].getHeaders();
      var loc = headers['Location'] || headers['location'];
      if (code >= 300 && code < 400 && loc && /^https?:\/\//.test(loc)) resolved[batch[i]] = loc;
    }
  }

  var ok = 0, total = 0;
  forEachItem(data, function(it) {
    var srcs = (it.__sourceUris || []).slice(0, SOURCES_PER_ITEM);
    if (srcs.length === 0) return;
    total++;
    // 해소 실패 시 원본 grounding 리다이렉트 URI 를 그대로 쓰지 않는다 —
    // 항상 https(vertexaisearch...) 형태이긴 하나, 이 값이 이메일 href 로
    // 직행하므로 스킴을 다시 한번 명시적으로 검증해 불변식을 코드로 못박는다.
    var primary = resolved[srcs[0]] || srcs[0];
    if (resolved[srcs[0]]) ok++;
    if (/^https?:\/\//i.test(primary)) {
      it.sourceUrl = primary;
      it.sourceDomain = extractDomain(primary);
      it.__urlSource = 'grounding';
    }
    if (srcs.length > 1) {
      var secondary = resolved[srcs[1]] || srcs[1];
      if (/^https?:\/\//i.test(secondary)) {
        it.sourceUrl2 = secondary;
        it.sourceDomain2 = extractDomain(secondary);
      }
    }
  });
  Logger.log('[출처 1] grounding 해소: ' + ok + '/' + total + '건');
}

/** [2단계] 모델이 직접 적은 URL 접속 검증 (200~399 + 경로 있는 URL 만 채택) */
function validateModelUrls(data, startMs) {
  var targets = [];
  forEachItem(data, function(it) {
    if (it.sourceUrl || !it.__modelUrl) return;
    if (!urlHasPath(it.__modelUrl)) return;
    targets.push(it);
  });
  if (targets.length === 0) return;
  targets = targets.slice(0, URL_VALIDATE_MAX);

  Logger.log('[출처 2] 모델 URL 검증: ' + targets.length + '건');
  var ok = 0, done = 0;
  for (var s = 0; s < targets.length; s += SOURCE_BATCH_SIZE) {
    if (s > 0 && budgetLeftMs(startMs) < FINISH_RESERVE_MS) {
      Logger.log('[출처 2] 시간 예산 부족 → 잔여 ' + (targets.length - s) + '건 생략'); break;
    }
    var batch = targets.slice(s, s + SOURCE_BATCH_SIZE);
    var resps = safeFetchAll(batch.map(function(it) {
      return { url: it.__modelUrl, method: 'get', followRedirects: true, muteHttpExceptions: true };
    }), startMs);
    for (var i = 0; i < batch.length; i++) {
      done++;
      if (!resps[i]) continue;
      var code = resps[i].getResponseCode();
      if (code >= 200 && code < 400) {
        batch[i].sourceUrl = batch[i].__modelUrl;
        batch[i].sourceDomain = extractDomain(batch[i].__modelUrl);
        batch[i].__urlSource = 'model';
        ok++;
      }
    }
  }
  Logger.log('[출처 2] 검증 통과: ' + ok + '/' + done + '건');
}

/** [3단계] Bing 뉴스 RSS 에서 영문 제목으로 발행사 원문 URL 매칭 */
function searchNewsRss(data, startMs) {
  var targets = [];
  forEachItem(data, function(it) {
    if (!it.sourceUrl && (it.titleEn || it.title)) targets.push(it);
  });
  if (targets.length === 0) return;
  targets = targets.slice(0, NEWS_SEARCH_MAX);

  Logger.log('[출처 3] 뉴스 RSS 검색: ' + targets.length + '건');
  var ok = 0, done = 0;
  for (var s = 0; s < targets.length; s += SOURCE_BATCH_SIZE) {
    if (s > 0 && budgetLeftMs(startMs) < FINISH_RESERVE_MS) {
      Logger.log('[출처 3] 시간 예산 부족 → 잔여 ' + (targets.length - s) + '건 생략'); break;
    }
    var batch = targets.slice(s, s + SOURCE_BATCH_SIZE);
    var resps = safeFetchAll(batch.map(function(it) {
      var q = it.titleEn || it.title;
      return { url: 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss',
        method: 'get', muteHttpExceptions: true };
    }), startMs);
    for (var i = 0; i < batch.length; i++) {
      done++;
      batch[i].__rssTried = true; // enforceRecency 가 중복으로 다시 RSS 조회하지 않도록 표시
      if (!resps[i] || resps[i].getResponseCode() !== 200) continue;
      var best = pickBestNewsMatch(batch[i], parseRssItems(resps[i].getContentText()));
      if (best) {
        if (best.link) {
          batch[i].sourceUrl = best.link;
          batch[i].sourceDomain = extractDomain(best.link);
          batch[i].__urlSource = 'news-rss';
          ok++;
        }
        // 링크는 채택하지 못했어도(bing/msn 등) 객관적 발행일은 최신성 검증에 유용하므로 보존
        if (best.pubDate) batch[i].__pubDate = best.pubDate;
      }
    }
  }
  Logger.log('[출처 3] RSS 매칭: ' + ok + '/' + done + '건');
}

/** RSS XML 에서 item title/link/pubDate 추출 (CDATA, 엔티티 처리, 최대 10건) */
function parseRssItems(xml) {
  var items = [];
  var re = /<item>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = re.exec(xml)) !== null && items.length < 10) {
    var block = m[1];
    var lm = block.match(/<link>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/link>/);
    var tm = block.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/);
    var pm = block.match(/<pubDate>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/pubDate>/i);
    if (lm && lm[1]) {
      items.push({
        link: decodeXmlEntities(lm[1].trim()),
        title: tm ? decodeXmlEntities(tm[1].trim()) : '',
        pubDate: pm ? decodeXmlEntities(pm[1].trim()) : ''
      });
    }
  }
  return items;
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

/** Bing RSS link 는 apiclick.aspx?...&url=<원문> 리다이렉트가 많음 → url= 추출 */
function unwrapBingLink(link) {
  if (!/^https?:\/\/([^\/]*\.)?bing\.com\//i.test(link)) return link;
  var m = link.match(/[?&]url=([^&]+)/i);
  if (!m) return '';
  try { var d = decodeURIComponent(m[1]); return /^https?:\/\//i.test(d) ? d : ''; }
  catch (e) { return ''; }
}

/**
 * RSS 결과 중 항목과 제목이 가장 잘 맞는 엔트리 선택.
 * @return {{link:string, pubDate:string} | null}
 *   link 는 발행사 원문 URL (bing/msn 등 비원문이면 ''). pubDate 는 해당
 *   엔트리의 객관적 발행일(enforceRecency 최신성 검증용) — link 채택 여부와 무관하게 반환.
 *   임계(NEWS_MATCH_THRESHOLD) 미달이면 null.
 */
function pickBestNewsMatch(item, entries) {
  var titleN = normalizeTitle(item.titleEn || item.title);
  var srcN = normalizeSourceName(item.sourceName);
  var best = null, bestScore = -1, bestEntry = null;
  entries.forEach(function(e) {
    var score = diceSimilarity(titleN, normalizeTitle(e.title));
    if (score > bestScore) { bestScore = score; bestEntry = e; }
  });
  if (!bestEntry || bestScore < NEWS_MATCH_THRESHOLD) return null;

  var link = unwrapBingLink(bestEntry.link);
  var dom = (link && /^https?:\/\//.test(link)) ? extractDomain(link) : '';
  var isOriginal = dom && dom.indexOf('bing.com') === -1 && dom.indexOf('msn.com') === -1;
  var domCore = normalizeSourceName(dom.split('.')[0] || '');
  if (isOriginal && srcN.length >= 3 && domCore.length >= 3 &&
      (srcN.indexOf(domCore) !== -1 || domCore.indexOf(srcN) !== -1)) {
    // 출처명-도메인 일치 가산 — link 채택 여부에는 영향 없이 참고용으로만 유지
  }
  return { link: isOriginal ? link : '', pubDate: bestEntry.pubDate || '' };
}

/** RSS pubDate(RFC-822 등) 문자열 → Date. 파싱 불가 시 null. */
function parsePubDate(s) {
  if (!s) return null;
  var t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}

/**
 * 최신성 객관 검증(안전망): 모델이 자기보고한 announcedDate 가 실제보다
 * 최신으로 환각된 경우를 방어한다. RSS 매칭(searchNewsRss)에서 이미
 * pubDate 를 얻은 항목은 그것을 쓰고, 아직 못 얻은 항목은 제목으로 한 번 더
 * Bing 뉴스 RSS 를 조회해 객관적 발행일만 보강한다. 이 발행일이 수집 기간
 * 시작보다 RECENCY_GRACE_HOURS 이상 오래됐으면 항목을 제거한다.
 * @param {Object} data 공통 데이터 구조
 * @param {Date} fromDate 수집 기간 시작
 */
function enforceRecency(data, fromDate) {
  var floor = new Date(fromDate.getTime() - RECENCY_GRACE_HOURS * 60 * 60 * 1000);

  // 1) 아직 __pubDate 가 없는 항목 → 제목으로 RSS 조회해 발행일만 보강
  var need = [];
  forEachItem(data, function(it) {
    if (!it.__pubDate && !it.__rssTried && (it.titleEn || it.title)) need.push(it);
  });
  need = need.slice(0, NEWS_SEARCH_MAX);
  if (need.length > 0) {
    Logger.log('[신선도] 발행일 보강 RSS 조회: ' + need.length + '건');
    var resps = safeFetchAll(need.map(function(it) {
      var q = it.titleEn || it.title;
      return { url: 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss',
        method: 'get', muteHttpExceptions: true };
    }));
    for (var i = 0; i < need.length; i++) {
      if (!resps[i] || resps[i].getResponseCode() !== 200) continue;
      var best = pickBestNewsMatch(need[i], parseRssItems(resps[i].getContentText()));
      if (best && best.pubDate) need[i].__pubDate = best.pubDate;
    }
  }

  // 2) 객관적 발행일이 기간 시작보다 오래된 항목 제거
  var dropped = 0, verified = 0;
  forEachUnit(data, function(domain, unit, items, setItems) {
    var kept = items.filter(function(it) {
      var pd = parsePubDate(it.__pubDate);
      if (!pd) return true; // 객관적 발행일 확인 불가 → 모델 날짜 필터에 위임(유지)
      verified++;
      if (pd.getTime() < floor.getTime()) {
        dropped++;
        Logger.log('[신선도] 제외(' + domain.label + '/' + unit.key + '): ' + it.title +
          ' / 모델주장 ' + it.announcedDate + ' / 실제발행 ' + it.__pubDate);
        return false;
      }
      return true;
    });
    setItems(kept);
  });
  Logger.log('[신선도] 객관 검증 ' + verified + '건, 기간초과 제외 ' + dropped + '건 (하한 ' +
    Utilities.formatDate(floor, 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' KST)');
}

/** 도메인 뒤 실제 경로가 있는 URL 인지 (홈페이지 단독 URL 배제) */
function urlHasPath(url) {
  var m = (url || '').toString().match(/^https?:\/\/[^\/]+(\/[^?#]*)?/i);
  var path = (m && m[1]) ? m[1].replace(/\/+$/, '') : '';
  return path.length > 1;
}

/** URL → 도메인 (www. 제거). 구글 리다이렉트면 빈 문자열. */
function extractDomain(url) {
  if (!url) return '';
  var m = url.toString().match(/^https?:\/\/([^\/:?#]+)/i);
  if (!m) return '';
  var host = m[1].toLowerCase().replace(/^www\./, '');
  if (host.indexOf('vertexaisearch.cloud.google.com') !== -1) return '';
  return host;
}

/** 항목 클릭 링크 결정: 원문 URL → Google 검색 링크 폴백 */
function getItemLink(item) {
  if (item.sourceUrl) {
    return { url: item.sourceUrl, label: item.sourceDomain || '원문 보기', isOriginal: true };
  }
  var q = (item.titleEn || item.title || '') + (item.issuingCountry ? ' ' + item.issuingCountry : '');
  if (!q.trim()) return null;
  return { url: 'https://www.google.com/search?q=' + encodeURIComponent(q.trim()), label: 'Google 검색', isOriginal: false };
}


// ============================================================
//  문자열 유사도 / 정규화 (중복 제거·RSS 매칭 공용)
// ============================================================
function normalizeSourceName(s) {
  return (s || '').toString().toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

function normalizeTitle(t) {
  return (t || '').toString().toLowerCase()
    .replace(/[\s ]+/g, '')
    .replace(/[.,·、:;'"“”‘’()\[\]\-–—_/\\|!?%~…]+/g, '');
}

/** bigram Dice 유사도 (0~1) */
function diceSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  var A = {}, B = {}, i, k;
  for (i = 0; i < a.length - 1; i++) A[a.substring(i, i + 2)] = true;
  for (i = 0; i < b.length - 1; i++) B[b.substring(i, i + 2)] = true;
  var ca = 0, cb = 0, inter = 0;
  for (k in A) { ca++; if (B[k]) inter++; }
  for (k in B) cb++;
  return (2 * inter) / (ca + cb);
}
