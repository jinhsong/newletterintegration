import net from 'node:net';
import { domains } from './config.mjs';

const DOMAIN_CIRCLED = ['①', '②', '③', '④', '⑤'];
const IMPORTANCE_PALETTE = Object.freeze({
  상: Object.freeze({ color: '#c62828', background: '#fdecea', text: '#c62828' }),
  중: Object.freeze({ color: '#ef6c00', background: '#fff3e0', text: '#8a4b00' }),
  하: Object.freeze({ color: '#2e7d32', background: '#e8f5e9', text: '#2e7d32' }),
});

function domainPaletteStyle(domain) {
  const palette = domain.palette || {};
  const band = palette.band || domain.color || '#526073';
  const catBg = palette.catBg || domain.softColor || '#f1f3f6';
  const catBorder = palette.catBorder || domain.color || '#526073';
  const catText = palette.catText || domain.color || '#384860';
  const chip = palette.chip || domain.color || '#526073';
  return [
    `--domain-band:${band}`,
    `--domain-cat-bg:${catBg}`,
    `--domain-cat-border:${catBorder}`,
    `--domain-cat-text:${catText}`,
    `--domain-chip:${chip}`,
  ].join(';');
}

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

function itemCard(item, { unit = null, headingLevel = 4 } = {}) {
  const headingTag = headingLevel === 3 ? 'h3' : 'h4';
  const importance = IMPORTANCE_PALETTE[item.importance]
    || { color: '#90a4ae', background: '#eceff1', text: '#526073' };
  const categoryLabel = item.measureType || item.issuingCountry || unit?.label || '';
  const meta = [
    metaItem('발표', dateLabel(item.announcedDate)),
    metaItem('발표시각', item.announcedAt),
    metaItem('발표국·기구', item.issuingCountry),
    metaItem('대상', item.targetCountries),
    metaItem('기관', item.agency),
    metaItem('HS', item.hsCode),
  ].filter(Boolean).join('');

  return `
    <article class="item-card" style="--importance-color:${importance.color};--importance-bg:${importance.background};--importance-text:${importance.text}">
      <div class="item-badges">
        <span class="importance">${escapeHtml(item.importance)}</span>
        ${categoryLabel ? `<span class="domain-chip">${escapeHtml(categoryLabel)}</span>` : ''}
        ${item.effectiveDate ? `<span class="effective-chip">시행 ${escapeHtml(dateLabel(item.effectiveDate))}</span>` : ''}
      </div>
      <div class="item-heading">
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

function domainSection(domain, payload, domainIndex) {
  const result = payload.results?.[domain.key] || { categories: {} };
  const domainStats = payload.stats?.byDomain?.[domain.key] || { total: 0 };
  const failure = failureForDomain(payload, domain.key);
  const state = domainState(domain, payload, result);
  const categorySections = domain.units.map((unit) => {
    const items = result.categories?.[unit.key] || [];
    const highCount = items.filter((item) => item.importance === '상').length;
    const category = categoryState(result, unit.key, failure);
    const categoryInsight = result.categoryInsights?.[unit.key] || '';
    return `
      <section class="category">
        <div class="category-heading">
          <div class="category-title"><h3>${escapeHtml(unit.label)}</h3><div class="category-meta"><span>${items.length}건${highCount > 0 ? ` · 상 ${highCount}` : ''}</span><span class="state-chip state-${escapeHtml(category.status)}">${categoryStateLabel(category, items.length)}</span></div></div>
          ${unit.description ? `<p class="category-description">${escapeHtml(unit.description)}</p>` : ''}
        </div>
        ${categoryInsight ? `<div class="category-insight"><b>카테고리 요약</b><p>${escapeHtml(categoryInsight)}</p></div>` : ''}
        ${items.length > 0
    ? `<div class="items">${items.map((item) => itemCard(item, { unit })).join('')}</div>`
    : emptyCategoryMessage(category)}
      </section>`;
  }).join('');

  return `
    <section class="domain" id="domain-${escapeHtml(domain.key)}" style="${domainPaletteStyle(domain)}">
      <div class="domain-heading">
        <div>
          <p class="domain-part">PART ${domainIndex + 1}</p>
          <h2>${DOMAIN_CIRCLED[domainIndex] || ''} ${escapeHtml(domain.label)} 동향</h2>
          <p class="domain-state state-${state.kind}"><b>${state.label}</b><span>${escapeHtml(state.detail)}</span></p>
        </div>
        <div class="domain-count"><strong>${domainStats.total}</strong><span>건</span>${domainStats.high > 0 ? `<small>중요 상 ${domainStats.high}건</small>` : ''}</div>
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
        <div><h2>오늘의 하이라이트 · 중요도 상 ${items.length}건</h2><p class="section-help">영역별 최신 항목을 우선 포함한 뒤 발표일 최신순으로 표시합니다.</p></div>
        <span>${selected.length}/${items.length}건 표시</span>
      </div>
      <div class="priority-grid">
        ${selected.map(({ domain, unit, item }) => `
          <article class="priority-wrap" style="${domainPaletteStyle(domain)}">
            <span class="priority-label">${escapeHtml(domain.label)}</span>
            <div class="priority-content">
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(unit.label)}${item.announcedDate ? ` · ${escapeHtml(dateLabel(item.announcedDate))}` : ''}</p>
              <div class="priority-source">${sourceLink(item)}</div>
            </div>
          </article>`).join('')}
      </div>
    </section>`;
}

export function renderMonitoringHtml(payload) {
  const requestedDomains = visibleDomains(payload);
  const nav = requestedDomains.map((domain, index) => (
    `<a href="#domain-${escapeHtml(domain.key)}" style="${domainPaletteStyle(domain)}">${DOMAIN_CIRCLED[index] || ''} ${escapeHtml(domain.label)} <b>${payload.stats?.byDomain?.[domain.key]?.total ?? 0}</b></a>`
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
    :root{color-scheme:light;--ink:#1a2a4a;--body:#46566a;--muted:#7c8b9a;--line:#dde1e7;--paper:#fff;--canvas:#eef1f5;--navy:#0d1b30;--gold:#ffd54f;--high:#c62828;--high-bg:#fdecea;--mid:#ef6c00;--mid-bg:#fff3e0;--low:#2e7d32;--low-bg:#e8f5e9}
    *{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--canvas)}body{margin:0;padding:16px 8px;background:var(--canvas);color:var(--ink);font-family:"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",Arial,sans-serif;line-height:1.6;overflow-wrap:anywhere}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    a{color:inherit}a:focus-visible{outline:3px solid var(--gold);outline-offset:3px}.shell{width:100%;max-width:680px;margin:0 auto;background:var(--paper);border:1px solid var(--line)}.hero{background:var(--navy);color:#fff;padding:26px 28px}
    .hero-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.hero .eyebrow{color:#9fb4d0}.eyebrow{margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:.12em}.hero h1{margin:0;font-size:21px;letter-spacing:-.035em;line-height:1.4}.hero-sub{margin:5px 0 0;color:#9fb4d0;font-size:12px}.period{text-align:right;color:#9fb4d0;font-size:11px}.period b{display:block;color:#fff;font-size:13px}.period small{display:block;max-width:310px;margin-top:3px;color:#7088a8;font-size:10px;line-height:1.45}.quick-nav{display:flex;gap:4px 6px;flex-wrap:wrap;margin-top:14px}.quick-nav a{display:inline-block;padding:4px 11px;border-radius:14px;background:var(--domain-band);color:#fff;font-size:12px;white-space:nowrap;text-decoration:none}.quick-nav b{margin-left:4px}.hero-summary{margin:10px 0 0;color:var(--gold);font-size:12px}.hero-summary b{font-size:13px}
    .status,.research-notice{display:flex;gap:10px;align-items:flex-start;margin:0;padding:10px 28px;border:0;border-top:3px solid;font-size:12px;line-height:1.6}.status b,.research-notice>b{flex:0 0 auto;white-space:nowrap}.status span,.research-notice span{color:inherit}.status-ok{background:#eaf6ee;border-color:#2e8b57;color:#22643c}.status-mock{background:#fdecea;border-color:#c62828;color:#9c2a20}.status-warn{display:block;background:#fff3e0;border-color:#ef6c00;color:#8a5300}.status-warn span{margin-left:8px}.status ul{margin:6px 0 0 18px;padding:0}.status code{margin:0 4px;padding:1px 4px;background:rgba(255,255,255,.75);border-radius:3px}.research-notice{background:#eef5fc;border-color:#1a4d8f;color:#315577}.research-notice>b{color:#15406f}
    .priority{margin:0;padding:16px 28px 18px;background:#fff8f8;border-top:3px solid var(--high);border-bottom:1px solid #f0d8d8}.section-title{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.section-title h2{margin:0;color:var(--high);font-size:13px;letter-spacing:-.02em}.section-title>span{flex:0 0 auto;padding:2px 7px;border-radius:3px;background:var(--high-bg);color:var(--high);font-size:11px;font-weight:800}.section-help{margin:3px 0 0;color:var(--muted);font-size:11px}.priority-grid{display:grid;gap:7px;margin-top:8px}.priority-wrap{display:flex;gap:8px;align-items:flex-start}.priority-label{flex:0 0 auto;display:inline-block;margin-top:2px;padding:1px 7px;border-radius:3px;background:var(--domain-chip);color:#fff;font-size:11px;font-weight:800;white-space:nowrap}.priority-content{min-width:0}.priority-content h3{margin:0;color:var(--ink);font-size:13px;line-height:1.6}.priority-content>p{margin:0;color:#9aa7b4;font-size:11px}.priority-source{margin-top:2px}.priority-source .source{font-size:11px}.priority-source .source-verification{font-size:10px}
    .domain{margin:0;border-top:18px solid var(--canvas);background:#fff}.domain-heading{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:18px 28px;background:var(--domain-band);border-left:8px solid var(--gold);color:#fff}.domain-part{margin:0;color:var(--gold);font-size:11px;font-weight:800;letter-spacing:.09em}.domain-heading h2{margin:2px 0 0;color:#fff;font-size:20px;letter-spacing:-.03em;line-height:1.3}.domain-state{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:7px 0 0;font-size:11px}.domain-state b{padding:1px 6px;border-radius:3px;background:rgba(255,255,255,.94);color:#384860}.domain-state span{color:#dbe5ef}.domain-state.state-ok b{color:#24623a}.domain-state.state-warn b{color:#8a5300}.domain-state.state-unknown b{color:#526073}.domain-count{text-align:right;color:#fff;white-space:nowrap}.domain-count strong{font-size:18px}.domain-count>span{margin-left:2px;font-size:13px}.domain-count small{display:block;color:#ffd9d9;font-size:11px}.insight{margin:0;padding:14px 28px;background:var(--domain-cat-bg);border-bottom:1px solid var(--domain-cat-bg)}.insight b{color:var(--domain-cat-text);font-size:12px}.insight p{margin:5px 0 0;color:#3a4a5a;font-size:13px;line-height:1.8}
    .category{margin:0}.category-heading{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:9px 28px 9px 24px;background:var(--domain-cat-bg);border-left:4px solid var(--domain-cat-border)}.category-title{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}.category-heading h3{margin:0;color:var(--domain-cat-text);font-size:13px;white-space:nowrap}.category-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.category-meta>span{color:#7c8b9a;font-size:11px}.category-meta .state-chip{padding:1px 6px;border-radius:3px;background:#eef1f5}.category-meta .state-success,.category-meta .state-empty{background:#e7f6ec;color:#24623a}.category-meta .state-failure{background:#fff0cf;color:#7b5200}.category-description{max-width:52%;margin:0;color:#9aa7b4;font-size:10px;line-height:1.5;text-align:right}.category-insight{margin:0;padding:9px 28px;background:#fbfcfe;border-bottom:1px solid #eef1f5;font-size:12px;color:#4a5a6a}.category-insight b{color:var(--domain-cat-text)}.category-insight p{display:inline;margin:0 0 0 7px;line-height:1.7}.items{display:block;margin:0;padding:4px 20px 14px}.item-card{margin-top:12px;padding:12px 16px;border:1px solid #e2e8f0;border-left:5px solid var(--importance-color);border-radius:0;background:#fff}.item-badges{display:flex;gap:5px;align-items:center;flex-wrap:wrap}.importance,.domain-chip,.effective-chip{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:800;line-height:1.5}.importance{border:1px solid var(--importance-color);background:var(--importance-bg);color:var(--importance-text)}.domain-chip{background:var(--domain-chip);color:#fff}.effective-chip{border:1px solid #8fcccc;background:#e0f3f3;color:#0b6e6e}.item-heading{margin-top:9px}.item-heading h3,.item-heading h4{margin:0;color:var(--ink);font-size:14px;letter-spacing:-.02em;line-height:1.6}.title-en{margin:2px 0 0;color:#8a98a8;font-size:11px}.summary{margin:6px 0 0;color:var(--body);font-size:13px;line-height:1.75}.meta{display:flex;flex-wrap:wrap;gap:3px 13px;margin:10px 0 0;color:#7c8b9a;font-size:11px;line-height:1.9}.meta b{margin-right:3px;color:#9aa7b4;font-weight:400}.impact,.reason,.notes{margin:7px 0 0;padding-left:9px;border-left:2px solid #dde3ec;color:#667789;font-size:11px;line-height:1.7}.impact b,.reason b,.notes b{margin-right:6px;color:#46566a}.source-row{margin-top:9px}.source-block{display:flex;gap:5px 9px;align-items:center;flex-wrap:wrap}.source{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;color:#15418c;font-size:11px;font-weight:700;text-decoration:none}.source:hover .source-action{text-decoration:underline}.source-host{padding:1px 5px;border-radius:3px;background:#edf2f7;color:#526073;font-weight:500}.source-verification{padding:1px 6px;border-radius:3px;background:#fff4da;color:#735200;font-size:10px}.verification-grounded{background:#e7f6ec;color:#24623a}.verification-missing{background:#fdecec;color:#8e2f2f}.verification-unknown{background:#eef1f5;color:#526073}.source-muted{color:var(--muted);font-weight:400}.empty-category{margin:0;padding:9px 28px;border-bottom:1px solid #eef1f5;background:#fff;color:#9aa7b4;font-size:11px;font-style:italic}.empty-failed{background:#fff8ec;color:#a15c00;font-style:normal}.empty-failed b{margin-right:5px}.empty-unknown{background:#f6f8fa;color:#526073;font-style:normal}
    .footer{margin:0;padding:14px 28px;border-top:1px solid #dde3ea;background:#f0f3f7;color:#7a8a9a;text-align:center;font-size:11px;line-height:1.7}.footer b{color:#384860}
    @media(max-width:720px){body{padding:0}.shell{border:0}.hero{padding:22px 20px}.hero-top{display:block}.period{margin-top:14px;text-align:left}.period small{max-width:none}.status,.research-notice{display:block;padding:10px 20px}.status span,.research-notice span{display:block;margin:3px 0 0}.status-warn span{margin-left:0}.priority{padding:14px 20px 16px}.domain-heading{align-items:flex-end;padding:16px 20px;border-left-width:6px}.insight{padding:12px 20px}.category-heading{padding:9px 20px 9px 16px}.category-description{max-width:46%}.category-insight{padding:9px 20px}.items{padding:4px 12px 12px}.item-card{padding:11px 13px}.empty-category{padding:9px 20px}.footer{padding:13px 20px}}
    @media(max-width:480px){.hero-top,.section-title,.category-heading{display:block}.section-title>span{display:inline-block;margin-top:5px}.category-description{max-width:none;margin-top:3px;text-align:left}.domain-state{display:block}.domain-state span{display:block;margin-top:3px}.source-block{align-items:flex-start}.priority-wrap{gap:6px}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
    @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}html,body{background:#fff}body{padding:0}.shell{max-width:none;border:0}.hero{background:#fff;color:var(--ink);border-bottom:2px solid var(--navy)}.hero h1,.period b{color:var(--ink)}.hero .eyebrow,.hero-sub,.period,.period small{color:#526073}.quick-nav{display:none}.hero-summary{color:#7b5200}.domain{border-top:12px solid #fff}.domain-heading{background:#fff;color:var(--ink);border:2px solid var(--domain-band);border-left:8px solid var(--domain-band)}.domain-heading h2,.domain-count{color:var(--ink)}.domain-part,.domain-count small{color:var(--domain-cat-text)}.domain-state span{color:#526073}.priority{background:#fff}.item-card,.priority-wrap{break-inside:avoid}.category-heading{break-after:avoid}.footer{background:#fff}}
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
      <nav class="quick-nav" aria-label="영역 바로가기">${nav}</nav>
      <p class="hero-summary">합계 <b>${payload.stats?.total ?? 0}건</b> · 중요도 상 ${payload.stats?.high ?? 0}건 · 표시 가능 영역 ${payload.collection?.completedDomains ?? 0}/${payload.collection?.totalDomains ?? requestedDomains.length}</p>
    </header>
    ${mockBanner(payload)}
    ${failureBanner(payload)}
    ${researchNotice(payload)}
    ${highPriority(payload)}
    ${requestedDomains.map((domain, index) => domainSection(domain, payload, index)).join('')}
    <footer class="footer"><b>AI 예비 조사 · 원문 수동 확인 필수</b> · PC 로컬 HTML · 생성 ${escapeHtml(generatedLabel(payload.createdAt))} KST · 외부 저장 및 메일 발송 없음</footer>
  </main>
</body>
</html>`;
}

export { escapeHtml };
