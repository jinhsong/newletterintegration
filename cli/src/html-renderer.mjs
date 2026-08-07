import net from 'node:net';
import { domains } from './config.mjs';

function visibleDomains(payload) {
  const requested = payload?.collection?.requestedCategoryIds;
  if (!Array.isArray(requested)) return domains;
  const ids = new Set(requested.map(String));
  return domains.map((domain) => ({
    ...domain,
    units: domain.units.filter((unit) => ids.has(`${domain.key}:${unit.key}`)),
  })).filter((domain) => domain.units.length > 0);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return String(value ?? '');
  const [year, month, day] = String(value).split('-');
  return `${year}.${month}.${day}`;
}

function generatedLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '생성 시각 정보 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function metaItem(label, value) {
  if (!value) return '';
  return `<span><b>${escapeHtml(label)}</b> ${escapeHtml(value)}</span>`;
}

function sourceLink(item) {
  if (!item.sourceUrl) {
    return item.sourceName
      ? `<span class="source source-muted">원문 URL 없음 · 출처명 ${escapeHtml(item.sourceName)}</span>`
      : '<span class="source source-muted">원문 URL 없음</span>';
  }
  let hostname;
  try {
    const url = new URL(item.sourceUrl);
    const normalizedHost = url.hostname.toLowerCase().replace(/\.$/, '');
    const ipCandidate = normalizedHost.startsWith('[') && normalizedHost.endsWith(']')
      ? normalizedHost.slice(1, -1)
      : normalizedHost;
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || (url.port && url.port !== '443')
      || !normalizedHost.includes('.')
      || normalizedHost === 'localhost'
      || normalizedHost.endsWith('.localhost')
      || normalizedHost.endsWith('.local')
      || normalizedHost.endsWith('.lan')
      || normalizedHost.endsWith('.internal')
      || net.isIP(ipCandidate)
    ) throw new Error('안전하지 않은 URL');
    hostname = url.hostname.replace(/^www\./, '');
  } catch {
    return '<span class="source source-muted">안전한 HTTPS 원문 URL 없음</span>';
  }
  const sourceName = item.sourceName || '출처명 없음';
  const verification = item.sourceVerification === 'grounded'
    ? { kind: 'grounded', label: '검색 근거와 연결 · 원문 수동 확인' }
    : item.sourceVerification === 'format-only'
      ? { kind: 'format-only', label: 'HTTPS 형식 확인 · 원문 수동 확인 필요' }
      : item.sourceVerification === 'missing'
        ? { kind: 'missing', label: '원문 검증 정보 없음' }
        : { kind: 'unknown', label: '검증 상태 정보 없음 · 원문 수동 확인 필요' };
  return `<div class="source-block"><a class="source" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer"><span class="source-name">${escapeHtml(sourceName)}</span><span class="source-host">${escapeHtml(hostname)}</span><span class="source-action">원문 열기 <span aria-hidden="true">↗</span><span class="sr-only">(새 창)</span></span></a><span class="source-verification verification-${verification.kind}">${verification.label}</span></div>`;
}

function itemCard(item, { compact = false, headingLevel = 4 } = {}) {
  const headingTag = headingLevel === 3 ? 'h3' : 'h4';
  const meta = [
    metaItem('발표', dateLabel(item.announcedDate)),
    metaItem('발표시각', item.announcedAt),
    metaItem('시행', dateLabel(item.effectiveDate)),
    metaItem('조치', item.measureType),
    metaItem('발표국·기구', item.issuingCountry),
    metaItem('대상', item.targetCountries),
    metaItem('기관', item.agency),
    metaItem('HS', item.hsCode),
  ].filter(Boolean).join('');

  return `
    <article class="item-card${compact ? ' compact' : ''}">
      <div class="item-heading">
        <span class="importance importance-${escapeHtml(item.importance)}">${escapeHtml(item.importance)}</span>
        <${headingTag}>${escapeHtml(item.title)}</${headingTag}>
      </div>
      ${item.titleEn ? `<p class="title-en">${escapeHtml(item.titleEn)}</p>` : ''}
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      <p class="summary">${escapeHtml(item.summary || '요약 없음')}</p>
      ${item.businessImpact ? `<p class="impact"><b>기업 영향</b> ${escapeHtml(item.businessImpact)}</p>` : ''}
      ${item.importanceReason ? `<p class="reason"><b>중요도 근거</b> ${escapeHtml(item.importanceReason)}</p>` : ''}
      ${item.notes ? `<p class="notes"><b>참고</b> ${escapeHtml(item.notes)}</p>` : ''}
      <div class="source-row">${sourceLink(item)}</div>
    </article>`;
}

function failureForDomain(payload, domainKey) {
  return (payload.failures || []).find((failure) => failure.domainKey === domainKey) || null;
}

function categoryState(result, unitKey, domainFailure) {
  const state = result?.categoryStatus?.[unitKey];
  if (state && ['success', 'empty', 'failure'].includes(state.status)) {
    if (
      state.status !== 'failure'
      && Number.isInteger(result?.coverage?.webSearchSuccesses)
      && result.coverage.webSearchSuccesses === 0
    ) {
      return { ...state, status: 'unknown', reason: '웹 검색 성공 기록 없음' };
    }
    return state;
  }
  if (domainFailure) {
    return {
      status: 'failure',
      coverage: 'none',
      reason: domainFailure.reason || '영역 조사 실패',
    };
  }
  return { status: 'unknown', coverage: 'unknown', reason: '' };
}

function categoryStateLabel(state, itemCount) {
  if (state.status === 'failure') return '확인 불가';
  const searchLabel = Number.isInteger(state.webSearchSuccesses) && state.webSearchSuccesses > 0
    ? `검색 ${state.webSearchSuccesses}회`
    : '검색 실행';
  if (state.coverage === 'fallback') return itemCount > 0 ? `재조사 결과 · ${searchLabel}` : `재조사 · ${searchLabel} · 0건`;
  if (state.status === 'empty') return `${searchLabel} · 0건`;
  if (state.status === 'success') return searchLabel;
  return '상태 정보 없음';
}

function emptyCategoryMessage(state) {
  if (state.status === 'failure') {
    const reason = state.reason ? ` 사유: ${escapeHtml(state.reason)}` : '';
    return `<p class="empty-category empty-failed"><b>수집 실패로 확인할 수 없습니다.</b>${reason}</p>`;
  }
  if (state.status === 'empty' || state.status === 'success') {
    return '<p class="empty-category">웹 검색을 마쳤으며, 조사 기간과 포함 기준을 충족한 신규 동향은 0건입니다.</p>';
  }
  return '<p class="empty-category empty-unknown">검색 상태 정보가 없어 신규 동향 유무를 판단할 수 없습니다.</p>';
}

function domainState(domain, payload, result) {
  const coverage = result?.coverage;
  const failure = failureForDomain(payload, domain.key);
  if (coverage && Number.isInteger(coverage.requestedCategories)) {
    const requested = coverage.requestedCategories;
    const completed = Number.isInteger(coverage.completedCategories)
      ? coverage.completedCategories
      : 0;
    const failed = Number.isInteger(coverage.failedCategories)
      ? coverage.failedCategories
      : Math.max(0, requested - completed);
    const searches = Number.isInteger(coverage.webSearchSuccesses)
      ? coverage.webSearchSuccesses
      : null;
    const warningCount = Number.isInteger(coverage.warningCount) ? coverage.warningCount : 0;
    const label = failed > 0
      ? (completed > 0 ? '부분 결과' : '확인 불가')
      : searches === 0 || searches === null
        ? '검색 상태 정보 없음'
        : '검색 실행 완료';
    const detail = [
      `카테고리 ${completed}/${requested}`,
      searches === null ? '' : `웹 검색 ${searches}회 성공`,
      warningCount > 0 ? `Claude 경고 ${warningCount}건` : '',
    ].filter(Boolean).join(' · ');
    return {
      label,
      detail,
      kind: failed > 0 ? 'warn' : (searches === 0 || searches === null ? 'unknown' : 'ok'),
    };
  }
  if (failure) return { label: '확인 불가', detail: failure.reason || '', kind: 'warn' };
  return { label: '상태 정보 없음', detail: '구버전 결과', kind: 'unknown' };
}

function domainSection(domain, payload) {
  const result = payload.results?.[domain.key] || { categories: {} };
  const domainStats = payload.stats?.byDomain?.[domain.key] || { total: 0 };
  const failure = failureForDomain(payload, domain.key);
  const state = domainState(domain, payload, result);
  const categorySections = domain.units.map((unit) => {
    const items = result.categories?.[unit.key] || [];
    const category = categoryState(result, unit.key, failure);
    const categoryInsight = result.categoryInsights?.[unit.key] || '';
    return `
      <section class="category">
        <div class="category-heading">
          <h3>${escapeHtml(unit.label)}</h3>
          <div class="category-meta"><span>${items.length}건</span><span class="state-chip state-${escapeHtml(category.status)}">${categoryStateLabel(category, items.length)}</span></div>
        </div>
        ${categoryInsight ? `<div class="category-insight"><b>카테고리 요약</b><p>${escapeHtml(categoryInsight)}</p></div>` : ''}
        ${items.length > 0
    ? `<div class="items">${items.map((item) => itemCard(item)).join('')}</div>`
    : emptyCategoryMessage(category)}
      </section>`;
  }).join('');

  return `
    <section class="domain" id="domain-${escapeHtml(domain.key)}" style="--domain:${domain.color};--domain-soft:${domain.softColor}">
      <div class="domain-heading">
        <div>
          <p class="eyebrow">MONITORING AREA</p>
          <h2>${escapeHtml(domain.label)}</h2>
          <p class="domain-state state-${state.kind}"><b>${state.label}</b><span>${escapeHtml(state.detail)}</span></p>
        </div>
        <div class="domain-count"><strong>${domainStats.total}</strong><span>건</span></div>
      </div>
      ${result.insight
    ? `<div class="insight"><b>핵심 흐름</b><p>${escapeHtml(result.insight)}</p></div>`
    : ''}
      ${categorySections}
    </section>`;
}

function failureBanner(payload) {
  const requestedDomains = visibleDomains(payload);
  const failures = payload.failures || [];
  const coverageGaps = requestedDomains.filter((domain) => {
    const coverage = payload.results?.[domain.key]?.coverage;
    return !coverage || (
      coverage.failedCategories > 0
      || coverage.complete === false
      || !Number.isInteger(coverage.webSearchSuccesses)
      || coverage.webSearchSuccesses === 0
    );
  });
  if (failures.length === 0 && coverageGaps.length === 0) {
    const total = payload.collection?.totalCategories ?? requestedDomains.reduce(
      (sum, domain) => sum + domain.units.length,
      0,
    );
    return `<div class="status status-ok"><b>결과 생성 완료</b><span>요청한 ${escapeHtml(total)}개 카테고리의 Claude Code 다각도 심층 검색 결과를 정리했습니다. 검색 범위와 원문을 수동으로 확인하세요.</span></div>`;
  }
  const failureItems = failures
    .map((failure) => `<li><b>${escapeHtml(failure.domainLabel)}${failure.categoryLabel ? ` / ${escapeHtml(failure.categoryLabel)}` : ''}</b> <code>${escapeHtml(failure.code)}</code> ${escapeHtml(failure.reason)}</li>`)
    .join('');
  const failedKeys = new Set(failures.map((failure) => failure.domainKey));
  const hasUnavailableRange = failures.length > 0 || coverageGaps.some((domain) => (
    payload.results?.[domain.key]?.coverage?.failedCategories > 0
  ));
  const coverageItems = coverageGaps
    .filter((domain) => !failedKeys.has(domain.key))
    .map((domain) => {
      const coverage = payload.results?.[domain.key]?.coverage;
      if (!coverage) {
        return `<li><b>${escapeHtml(domain.label)}</b> 검색 상태 정보 없음(구버전 결과)</li>`;
      }
      return coverage.failedCategories > 0
        ? `<li><b>${escapeHtml(domain.label)}</b> ${coverage.failedCategories}개 카테고리 확인 불가</li>`
        : `<li><b>${escapeHtml(domain.label)}</b> 웹 검색 성공 기록 없음</li>`;
    })
    .join('');
  return `
    <div class="status status-warn" role="status">
      <b>${hasUnavailableRange ? '일부 범위 조사 실패' : '검색 상태 확인 필요'}</b>
      <span>${payload.collection?.completedDomains ?? 0}/${payload.collection?.totalDomains ?? requestedDomains.length}개 영역에 표시 가능한 결과가 있습니다. '신규 동향 0건', '확인 불가', '검색 기록 없음'을 구분해서 보세요.</span>
      <ul>${failureItems}${coverageItems}</ul>
    </div>`;
}

function mockBanner(payload) {
  if (payload.collection?.mode !== 'mock') return '';
  return '<div class="status status-mock" role="status"><b>테스트 데이터</b><span>Claude Code WebSearch를 실행하지 않은 내장 목 응답입니다. 실제 모니터링 결과로 사용하지 마세요.</span></div>';
}

function researchNotice(payload) {
  const dateNote = payload.context?.dateCoverageNote
    ? `<span><b>날짜 판정:</b> ${escapeHtml(payload.context.dateCoverageNote)}</span>`
    : '';
  return `
    <aside class="research-notice" aria-label="AI 조사 결과 이용 주의">
      <b>AI 예비 조사 결과 · 원문 수동 확인 필수</b>
      <span>모델이 웹 검색 결과를 정리한 자료입니다. 링크, 발표일, 적용 대상, 수치를 원문에서 확인한 뒤 의사결정에 사용하세요.</span>
      ${dateNote}
    </aside>`;
}

function comparePriority(a, b) {
  return String(b.item.announcedDate || '').localeCompare(String(a.item.announcedDate || ''))
    || String(b.item.announcedAt || '').localeCompare(String(a.item.announcedAt || ''))
    || a.domainIndex - b.domainIndex
    || a.unitIndex - b.unitIndex
    || a.itemIndex - b.itemIndex;
}

function selectPriorityItems(items, requestedDomains, maximum = 6) {
  const sorted = [...items].sort(comparePriority);
  const selected = [];
  const selectedItems = new Set();
  for (const domain of requestedDomains) {
    const candidate = sorted.find(({ domain: itemDomain }) => itemDomain.key === domain.key);
    if (candidate && selected.length < maximum) {
      selected.push(candidate);
      selectedItems.add(candidate);
    }
  }
  for (const candidate of sorted) {
    if (selected.length >= maximum) break;
    if (!selectedItems.has(candidate)) selected.push(candidate);
  }
  return selected.sort(comparePriority);
}

function highPriority(payload) {
  const requestedDomains = visibleDomains(payload);
  const items = [];
  for (const [domainIndex, domain] of requestedDomains.entries()) {
    for (const [unitIndex, unit] of domain.units.entries()) {
      for (const [itemIndex, item] of (payload.results?.[domain.key]?.categories?.[unit.key] || []).entries()) {
        if (item.importance === '상') items.push({ domain, unit, item, domainIndex, unitIndex, itemIndex });
      }
    }
  }
  if (items.length === 0) return '';
  const selected = selectPriorityItems(items, requestedDomains);
  return `
    <section class="priority">
      <div class="section-title">
        <div><p class="eyebrow">EXECUTIVE WATCH</p><h2>우선 검토할 동향</h2><p class="section-help">영역별 최신 항목을 우선 포함한 뒤 발표일 최신순으로 표시합니다.</p></div>
        <span>${selected.length}/${items.length}건 표시</span>
      </div>
      <div class="priority-grid">
        ${selected.map(({ domain, unit, item }) => `
          <div class="priority-wrap" style="--domain:${domain.color}">
            <p class="priority-label">${escapeHtml(domain.label)} · ${escapeHtml(unit.label)}</p>
            ${itemCard(item, { compact: true, headingLevel: 3 })}
          </div>`).join('')}
      </div>
    </section>`;
}

export function renderMonitoringHtml(payload) {
  const requestedDomains = visibleDomains(payload);
  const nav = requestedDomains.map((domain) => (
    `<a href="#domain-${escapeHtml(domain.key)}" style="--domain:${domain.color}">${escapeHtml(domain.label)} <b>${payload.stats?.byDomain?.[domain.key]?.total ?? 0}</b></a>`
  )).join('');
  const selection = payload.collection?.selection;
  const heroSubtitle = selection
    ? `선택 조사 · ${selection.domainLabel} / ${selection.unitLabel}`
    : '관세 · 수출통제 · 무역구제 신규 동향';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글로벌 통상 모니터링 ${escapeHtml(payload.context.toISO)}</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#64748b;--line:#dce3ec;--paper:#fff;--canvas:#f3f6fa;--navy:#10233f;--high:#c62828;--mid:#b45309;--low:#347052}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--canvas);color:var(--ink);font-family:"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",Arial,sans-serif;line-height:1.6}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    a{color:inherit}.shell{max-width:1120px;margin:0 auto;padding:32px 20px 64px}.hero{overflow:hidden;background:linear-gradient(135deg,#0c1d35,#183b68 70%,#225a89);border-radius:24px;color:#fff;padding:42px;box-shadow:0 20px 50px rgba(15,35,63,.16)}
    .hero-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.hero .eyebrow{color:#9fd0ff}.eyebrow{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.14em}.hero h1{margin:0;font-size:36px;letter-spacing:-.05em;line-height:1.25}.hero-sub{margin:12px 0 0;color:#d6e6f7;font-size:15px}
    .period{text-align:right;color:#d6e6f7;font-size:13px}.period b{display:block;color:#fff;font-size:15px}.period small{display:block;max-width:360px;margin-top:5px;color:#b9d0e7;font-size:11px;line-height:1.45}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:30px}.metric{padding:16px 18px;border:1px solid rgba(255,255,255,.18);border-radius:15px;background:rgba(255,255,255,.08)}.metric strong{display:block;font-size:28px;line-height:1.1}.metric span{font-size:12px;color:#c8daed}
    .status{display:flex;gap:12px;align-items:flex-start;margin:18px 0;padding:15px 18px;border-radius:13px;font-size:14px}.status b{white-space:nowrap}.status span{color:#42526a}.status-ok{background:#eaf8ef;border:1px solid #b9e3c7}.status-mock{background:#fdecec;border:2px solid #d85b5b}.status-mock b{color:#8e2020}.status-warn{display:block;background:#fff7e6;border:1px solid #f3ce81}.status-warn span{margin-left:10px}.status ul{margin:8px 0 0 20px}.status code{margin:0 5px;padding:2px 5px;background:#fff;border-radius:4px}.research-notice{display:flex;gap:12px;align-items:flex-start;margin:18px 0;padding:15px 18px;border:1px solid #b9c9dd;border-radius:13px;background:#eef5fc;font-size:13px}.research-notice b{flex:0 0 auto;color:#153e6f}.research-notice span{color:#42526a}
    .quick-nav{display:flex;gap:9px;flex-wrap:wrap;margin:18px 0 26px}.quick-nav a{text-decoration:none;background:#fff;border:1px solid var(--line);border-top:3px solid var(--domain);border-radius:10px;padding:9px 14px;font-size:13px}.quick-nav b{margin-left:5px}
    .priority,.domain{background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:26px;margin-top:22px;box-shadow:0 7px 22px rgba(15,35,63,.05)}.section-title,.domain-heading,.category-heading,.item-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.section-title h2,.domain-heading h2{margin:0;letter-spacing:-.04em}.section-title>span{background:#fdecec;color:var(--high);font-weight:800;padding:5px 10px;border-radius:999px}.section-help{margin:4px 0 0;color:var(--muted);font-size:12px}
    .priority-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}.priority-wrap{border-top:3px solid var(--domain);border-radius:13px;background:#fafbfd;padding:13px}.priority-label{margin:0 0 8px;color:var(--domain);font-size:12px;font-weight:800}.priority-wrap .item-card{border:0;padding:0;background:transparent}
    .domain{border-top:6px solid var(--domain)}.domain .eyebrow{color:var(--domain)}.domain-state{display:flex;gap:8px;align-items:center;margin:7px 0 0;font-size:12px}.domain-state b{padding:2px 7px;border-radius:999px}.domain-state span{color:var(--muted)}.domain-state.state-ok b{background:#e7f6ec;color:#24623a}.domain-state.state-warn b{background:#fff0cf;color:#7b5200}.domain-state.state-unknown b{background:#eef1f5;color:#526073}.domain-count{display:flex;align-items:baseline;gap:4px;color:var(--domain)}.domain-count strong{font-size:32px}.domain-count span{font-size:13px}.insight,.category-insight{margin:18px 0 24px;padding:17px 19px;border-left:4px solid var(--domain);background:var(--domain-soft);border-radius:0 12px 12px 0}.insight b,.category-insight b{color:var(--domain)}.insight p,.category-insight p{margin:4px 0 0}.category-insight{margin:12px 0 0;padding:12px 15px;font-size:13px}
    .category{margin-top:27px}.category-heading{padding-bottom:9px;border-bottom:2px solid var(--domain-soft)}.category-heading h3{margin:0;font-size:17px}.category-meta{display:flex;gap:7px;align-items:center}.category-heading span{color:var(--muted);font-size:12px}.category-heading .state-chip{padding:2px 7px;border-radius:999px;background:#eef1f5}.category-heading .state-success,.category-heading .state-empty{background:#e7f6ec;color:#24623a}.category-heading .state-failure{background:#fff0cf;color:#7b5200}.items{display:grid;gap:12px;margin-top:12px}.item-card{border:1px solid var(--line);border-radius:14px;padding:18px;background:#fff}.item-heading{justify-content:flex-start;align-items:flex-start}.item-heading h3,.item-heading h4{margin:0;font-size:17px;letter-spacing:-.025em}.importance{flex:0 0 auto;display:inline-grid;place-items:center;width:28px;height:25px;border-radius:7px;font-size:12px;font-weight:900;color:#fff}.importance-상{background:var(--high)}.importance-중{background:var(--mid)}.importance-하{background:var(--low)}
    .title-en{margin:4px 0 0 40px;color:var(--muted);font-size:12px}.meta{display:flex;flex-wrap:wrap;gap:5px 15px;margin:11px 0 0;padding:9px 11px;border-radius:9px;background:#f6f8fb;color:#5b687b;font-size:12px}.meta b{color:#344258;margin-right:3px}.summary{margin:12px 0 0}.impact,.reason,.notes{margin:10px 0 0;padding:10px 12px;border-radius:9px;font-size:13px}.impact{background:#fff8e8;color:#5e4a1f}.reason{background:#fdf2f2;color:#6c3434}.notes{background:#f6f8fb;color:#536074}.impact b,.reason b,.notes b{margin-right:7px}.source-row{margin-top:12px}.source-block{display:flex;gap:7px 12px;align-items:center;flex-wrap:wrap}.source{display:inline-flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:12px;font-weight:700;color:#1d5fa7;text-decoration:none}.source:hover .source-action{text-decoration:underline}.source-host{padding:1px 6px;border-radius:5px;background:#edf2f7;color:#526073;font-weight:500}.source-verification{padding:2px 7px;border-radius:999px;background:#fff4da;color:#735200;font-size:11px}.verification-grounded{background:#e7f6ec;color:#24623a}.verification-missing{background:#fdecec;color:#8e2f2f}.verification-unknown{background:#eef1f5;color:#526073}.source-muted{color:var(--muted);font-weight:400}.empty-category{margin:11px 0 0;padding:13px;background:#f8fafc;border-radius:10px;color:var(--muted);font-size:13px}.empty-failed{background:#fff7e6;color:#785700}.empty-failed b{margin-right:5px}.empty-unknown{background:#f1f3f6;color:#526073}
    .footer{text-align:center;margin-top:28px;color:var(--muted);font-size:12px}.footer b{color:#384860}
    @media(max-width:720px){.shell{padding:14px 10px 40px}.hero{padding:26px 22px;border-radius:18px}.hero-top{display:block}.hero h1{font-size:28px}.period{text-align:left;margin-top:18px}.metrics{grid-template-columns:1fr}.priority,.domain{padding:19px;border-radius:16px}.priority-grid{grid-template-columns:1fr}.status,.research-notice{display:block}.status span,.research-notice span{display:block;margin:3px 0 0}.title-en{margin-left:0}.domain-heading{align-items:flex-end}.domain-state{display:block}.category-heading{align-items:flex-start}.category-meta{justify-content:flex-end;flex-wrap:wrap}}
    @media print{body{background:#fff}.shell{max-width:none;padding:0}.hero,.priority,.domain{box-shadow:none;break-inside:avoid}.quick-nav{display:none}.item-card{break-inside:avoid}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="hero-top">
        <div>
          <p class="eyebrow">GLOBAL TRADE INTELLIGENCE</p>
          <h1>글로벌 통상 모니터링</h1>
          <p class="hero-sub">${escapeHtml(heroSubtitle)}</p>
        </div>
        <div class="period"><span>조사 기간</span><b>${escapeHtml(payload.context.fromStr)} ~ ${escapeHtml(payload.context.toStr)} KST</b>${payload.context.dateCoverageNote ? `<small>${escapeHtml(payload.context.dateCoverageNote)}</small>` : ''}</div>
      </div>
      <div class="metrics">
        <div class="metric"><strong>${payload.stats?.total ?? 0}</strong><span>HTML에 정리된 항목</span></div>
        <div class="metric"><strong>${payload.stats?.high ?? 0}</strong><span>중요도 '상' 분류</span></div>
        <div class="metric"><strong>${payload.collection?.completedDomains ?? 0}/${payload.collection?.totalDomains ?? requestedDomains.length}</strong><span>표시 가능한 영역</span></div>
      </div>
    </header>
    ${mockBanner(payload)}
    ${failureBanner(payload)}
    ${researchNotice(payload)}
    <nav class="quick-nav" aria-label="영역 바로가기">${nav}</nav>
    ${highPriority(payload)}
    ${requestedDomains.map((domain) => domainSection(domain, payload)).join('')}
    <footer class="footer"><b>AI 예비 조사 · 원문 수동 확인 필수</b> · PC 로컬 HTML · 생성 ${escapeHtml(generatedLabel(payload.createdAt))} KST · 외부 저장 및 메일 발송 없음</footer>
  </main>
</body>
</html>`;
}

export { escapeHtml };
