// ============================================================
//  원문 URL 확보 파이프라인 (4단계 폴백) — 전 도메인 항목 공용
//  1) groundingMetadata 리다이렉트 해소
//  2) 모델 제공 URL 접속 검증
//  3) Bing 뉴스 RSS 제목 검색 매칭
//  4) (렌더링 시) Google 검색 링크 — getItemLink
// ============================================================
function findSourceUrls(data, startMs) {
  resolveGroundingUrls(data); // 1단계

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

/** fetchAll 일괄 실패 시 개별 fetch 폴백 (네트워크 예외 방어) */
function safeFetchAll(requests) {
  var out = new Array(requests.length);
  try {
    var resps = UrlFetchApp.fetchAll(requests);
    for (var i = 0; i < resps.length; i++) out[i] = resps[i];
    return out;
  } catch (e) {
    Logger.log('[safeFetchAll] 일괄 실패 (' + e.message + ') → 개별 재시도');
  }
  for (var j = 0; j < requests.length; j++) {
    try { out[j] = UrlFetchApp.fetch(requests[j].url, requests[j]); } catch (e2) { out[j] = null; }
  }
  return out;
}

/** [1단계] grounding 리다이렉트 URL → Location 헤더로 원문 URL 해소 */
function resolveGroundingUrls(data) {
  var uriSet = {};
  forEachItem(data, function(it) {
    (it.__sourceUris || []).slice(0, SOURCES_PER_ITEM).forEach(function(u) { uriSet[u] = true; });
  });
  var uris = Object.keys(uriSet);
  if (uris.length === 0) { Logger.log('[출처 1] grounding 출처 없음'); return; }

  Logger.log('[출처 1] 리다이렉트 해소: ' + uris.length + '건');
  var resolved = {};
  for (var s = 0; s < uris.length; s += RESOLVE_BATCH_SIZE) {
    var batch = uris.slice(s, s + RESOLVE_BATCH_SIZE);
    var resps = safeFetchAll(batch.map(function(u) {
      return { url: u, method: 'get', followRedirects: false, muteHttpExceptions: true };
    }));
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
    var primary = resolved[srcs[0]] || srcs[0];
    if (resolved[srcs[0]]) ok++;
    it.sourceUrl = primary;
    it.sourceDomain = extractDomain(primary);
    it.__urlSource = 'grounding';
    if (srcs.length > 1) {
      it.sourceUrl2 = resolved[srcs[1]] || srcs[1];
      it.sourceDomain2 = extractDomain(it.sourceUrl2);
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
    }));
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
    }));
    for (var i = 0; i < batch.length; i++) {
      done++;
      if (!resps[i] || resps[i].getResponseCode() !== 200) continue;
      var best = pickBestNewsMatch(batch[i], parseRssItems(resps[i].getContentText()));
      if (best) {
        batch[i].sourceUrl = best;
        batch[i].sourceDomain = extractDomain(best);
        batch[i].__urlSource = 'news-rss';
        ok++;
      }
    }
  }
  Logger.log('[출처 3] RSS 매칭: ' + ok + '/' + done + '건');
}

/** RSS XML 에서 item title/link 추출 (CDATA, 엔티티 처리, 최대 10건) */
function parseRssItems(xml) {
  var items = [];
  var re = /<item>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = re.exec(xml)) !== null && items.length < 10) {
    var block = m[1];
    var lm = block.match(/<link>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/link>/);
    var tm = block.match(/<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/);
    if (lm && lm[1]) {
      items.push({ link: decodeXmlEntities(lm[1].trim()), title: tm ? decodeXmlEntities(tm[1].trim()) : '' });
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

/** RSS 결과 중 항목과 가장 잘 맞는 발행사 원문 URL 선택 */
function pickBestNewsMatch(item, entries) {
  var titleN = normalizeTitle(item.titleEn || item.title);
  var srcN = normalizeSourceName(item.sourceName);
  var best = null, bestScore = 0;
  entries.forEach(function(e) {
    var link = unwrapBingLink(e.link);
    if (!link || !/^https?:\/\//.test(link)) return;
    var dom = extractDomain(link);
    if (!dom || dom.indexOf('bing.com') !== -1 || dom.indexOf('msn.com') !== -1) return;
    var score = diceSimilarity(titleN, normalizeTitle(e.title));
    var domCore = normalizeSourceName(dom.split('.')[0]);
    if (srcN.length >= 3 && domCore.length >= 3 &&
        (srcN.indexOf(domCore) !== -1 || domCore.indexOf(srcN) !== -1)) score += 0.25;
    if (score > bestScore) { bestScore = score; best = link; }
  });
  return bestScore >= NEWS_MATCH_THRESHOLD ? best : null;
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
