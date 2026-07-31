import { domains } from './config.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function dateLabel(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return escapeHtml(value);
  const [year, month, day] = value.split('-');
  return `${year}.${month}.${day}`;
}

function generatedLabel(value) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value));
}

function metaItem(label, value) {
  if (!value) return '';
  return `<span><b>${escapeHtml(label)}</b> ${escapeHtml(value)}</span>`;
}

function sourceLink(item) {
  if (!item.sourceUrl) {
    return item.sourceName
      ? `<span class="source source-muted">출처: ${escapeHtml(item.sourceName)}</span>`
      : '<span class="source source-muted">원문 링크 없음</span>';
  }
  const label = item.sourceName || new URL(item.sourceUrl).hostname.replace(/^www\./, '');
  return `<a class="source" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} 원문 보기 <span aria-hidden="true">↗</span></a>`;
}

function itemCard(item, compact = false) {
  const meta = [
    metaItem('발표', dateLabel(item.announcedDate)),
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
        <h4>${escapeHtml(item.title)}</h4>
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

function domainSection(domain, payload) {
  const result = payload.results[domain.key];
  const domainStats = payload.stats.byDomain[domain.key];
  const categorySections = domain.units.map((unit) => {
    const items = result.categories[unit.key] || [];
    return `
      <section class="category">
        <div class="category-heading">
          <h3>${escapeHtml(unit.label)}</h3>
          <span>${items.length}건</span>
        </div>
        ${items.length > 0
    ? `<div class="items">${items.map((item) => itemCard(item)).join('')}</div>`
    : '<p class="empty-category">조사 기간 내 확인된 신규 동향이 없습니다.</p>'}
      </section>`;
  }).join('');

  return `
    <section class="domain" id="domain-${escapeHtml(domain.key)}" style="--domain:${domain.color};--domain-soft:${domain.softColor}">
      <div class="domain-heading">
        <div>
          <p class="eyebrow">MONITORING AREA</p>
          <h2>${escapeHtml(domain.label)}</h2>
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
  if (payload.failures.length === 0) {
    return '<div class="status status-ok"><b>수집 완료</b><span>세 영역의 조사가 정상적으로 완료되었습니다.</span></div>';
  }
  const failures = payload.failures
    .map((failure) => `<li><b>${escapeHtml(failure.domainLabel)}</b> <code>${escapeHtml(failure.code)}</code> ${escapeHtml(failure.reason)}</li>`)
    .join('');
  return `
    <div class="status status-warn">
      <b>일부 영역 수집 실패</b>
      <span>${payload.collection.completedDomains}/${payload.collection.totalDomains}개 영역 완료. 아래 결과는 부분 결과입니다.</span>
      <ul>${failures}</ul>
    </div>`;
}

function highPriority(payload) {
  const items = [];
  for (const domain of domains) {
    for (const unit of domain.units) {
      for (const item of payload.results[domain.key].categories[unit.key] || []) {
        if (item.importance === '상') items.push({ domain, unit, item });
      }
    }
  }
  if (items.length === 0) return '';
  return `
    <section class="priority">
      <div class="section-title">
        <div><p class="eyebrow">EXECUTIVE WATCH</p><h2>우선 확인할 동향</h2></div>
        <span>${items.length}건</span>
      </div>
      <div class="priority-grid">
        ${items.slice(0, 6).map(({ domain, unit, item }) => `
          <div class="priority-wrap" style="--domain:${domain.color}">
            <p class="priority-label">${escapeHtml(domain.label)} · ${escapeHtml(unit.label)}</p>
            ${itemCard(item, true)}
          </div>`).join('')}
      </div>
    </section>`;
}

export function renderMonitoringHtml(payload) {
  const nav = domains.map((domain) => (
    `<a href="#domain-${escapeHtml(domain.key)}" style="--domain:${domain.color}">${escapeHtml(domain.label)} <b>${payload.stats.byDomain[domain.key].total}</b></a>`
  )).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글로벌 통상 모니터링 ${escapeHtml(payload.context.toISO)}</title>
  <style>
    :root{color-scheme:light;--ink:#172033;--muted:#64748b;--line:#dce3ec;--paper:#fff;--canvas:#f3f6fa;--navy:#10233f;--high:#c62828;--mid:#b45309;--low:#347052}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--canvas);color:var(--ink);font-family:"Malgun Gothic","맑은 고딕","Apple SD Gothic Neo",Arial,sans-serif;line-height:1.6}
    a{color:inherit}.shell{max-width:1120px;margin:0 auto;padding:32px 20px 64px}.hero{overflow:hidden;background:linear-gradient(135deg,#0c1d35,#183b68 70%,#225a89);border-radius:24px;color:#fff;padding:42px;box-shadow:0 20px 50px rgba(15,35,63,.16)}
    .hero-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.hero .eyebrow{color:#9fd0ff}.eyebrow{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.14em}.hero h1{margin:0;font-size:36px;letter-spacing:-.05em;line-height:1.25}.hero-sub{margin:12px 0 0;color:#d6e6f7;font-size:15px}
    .period{text-align:right;color:#d6e6f7;font-size:13px}.period b{display:block;color:#fff;font-size:15px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:30px}.metric{padding:16px 18px;border:1px solid rgba(255,255,255,.18);border-radius:15px;background:rgba(255,255,255,.08)}.metric strong{display:block;font-size:28px;line-height:1.1}.metric span{font-size:12px;color:#c8daed}
    .status{display:flex;gap:12px;align-items:flex-start;margin:18px 0;padding:15px 18px;border-radius:13px;font-size:14px}.status b{white-space:nowrap}.status span{color:#42526a}.status-ok{background:#eaf8ef;border:1px solid #b9e3c7}.status-warn{display:block;background:#fff7e6;border:1px solid #f3ce81}.status-warn span{margin-left:10px}.status ul{margin:8px 0 0 20px}.status code{margin:0 5px;padding:2px 5px;background:#fff;border-radius:4px}
    .quick-nav{display:flex;gap:9px;flex-wrap:wrap;margin:18px 0 26px}.quick-nav a{text-decoration:none;background:#fff;border:1px solid var(--line);border-top:3px solid var(--domain);border-radius:10px;padding:9px 14px;font-size:13px}.quick-nav b{margin-left:5px}
    .priority,.domain{background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:26px;margin-top:22px;box-shadow:0 7px 22px rgba(15,35,63,.05)}.section-title,.domain-heading,.category-heading,.item-heading{display:flex;justify-content:space-between;gap:16px;align-items:center}.section-title h2,.domain-heading h2{margin:0;letter-spacing:-.04em}.section-title>span{background:#fdecec;color:var(--high);font-weight:800;padding:5px 10px;border-radius:999px}
    .priority-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:18px}.priority-wrap{border-top:3px solid var(--domain);border-radius:13px;background:#fafbfd;padding:13px}.priority-label{margin:0 0 8px;color:var(--domain);font-size:12px;font-weight:800}.priority-wrap .item-card{border:0;padding:0;background:transparent}
    .domain{border-top:6px solid var(--domain)}.domain .eyebrow{color:var(--domain)}.domain-count{display:flex;align-items:baseline;gap:4px;color:var(--domain)}.domain-count strong{font-size:32px}.domain-count span{font-size:13px}.insight{margin:18px 0 24px;padding:17px 19px;border-left:4px solid var(--domain);background:var(--domain-soft);border-radius:0 12px 12px 0}.insight b{color:var(--domain)}.insight p{margin:4px 0 0}
    .category{margin-top:27px}.category-heading{padding-bottom:9px;border-bottom:2px solid var(--domain-soft)}.category-heading h3{margin:0;font-size:17px}.category-heading span{color:var(--muted);font-size:12px}.items{display:grid;gap:12px;margin-top:12px}.item-card{border:1px solid var(--line);border-radius:14px;padding:18px;background:#fff}.item-heading{justify-content:flex-start;align-items:flex-start}.item-heading h4{margin:0;font-size:17px;letter-spacing:-.025em}.importance{flex:0 0 auto;display:inline-grid;place-items:center;width:28px;height:25px;border-radius:7px;font-size:12px;font-weight:900;color:#fff}.importance-상{background:var(--high)}.importance-중{background:var(--mid)}.importance-하{background:var(--low)}
    .title-en{margin:4px 0 0 40px;color:var(--muted);font-size:12px}.meta{display:flex;flex-wrap:wrap;gap:5px 15px;margin:11px 0 0;padding:9px 11px;border-radius:9px;background:#f6f8fb;color:#5b687b;font-size:12px}.meta b{color:#344258;margin-right:3px}.summary{margin:12px 0 0}.impact,.reason,.notes{margin:10px 0 0;padding:10px 12px;border-radius:9px;font-size:13px}.impact{background:#fff8e8;color:#5e4a1f}.reason{background:#fdf2f2;color:#6c3434}.notes{background:#f6f8fb;color:#536074}.impact b,.reason b,.notes b{margin-right:7px}.source-row{margin-top:12px}.source{font-size:12px;font-weight:700;color:#1d5fa7;text-decoration:none}.source:hover{text-decoration:underline}.source-muted{color:var(--muted);font-weight:400}.empty-category{margin:11px 0 0;padding:13px;background:#f8fafc;border-radius:10px;color:var(--muted);font-size:13px}
    .footer{text-align:center;margin-top:28px;color:var(--muted);font-size:12px}.footer b{color:#384860}
    @media(max-width:720px){.shell{padding:14px 10px 40px}.hero{padding:26px 22px;border-radius:18px}.hero-top{display:block}.hero h1{font-size:28px}.period{text-align:left;margin-top:18px}.metrics{grid-template-columns:1fr}.priority,.domain{padding:19px;border-radius:16px}.priority-grid{grid-template-columns:1fr}.status{display:block}.status span{display:block;margin:3px 0 0}.title-en{margin-left:0}.domain-heading{align-items:flex-end}}
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
          <p class="hero-sub">관세 · 수출통제 · 무역구제 신규 동향</p>
        </div>
        <div class="period"><span>조사 기간</span><b>${escapeHtml(payload.context.fromStr)} ~ ${escapeHtml(payload.context.toStr)} KST</b></div>
      </div>
      <div class="metrics">
        <div class="metric"><strong>${payload.stats.total}</strong><span>전체 동향</span></div>
        <div class="metric"><strong>${payload.stats.high}</strong><span>중요도 상</span></div>
        <div class="metric"><strong>${payload.collection.completedDomains}/${payload.collection.totalDomains}</strong><span>수집 완료 영역</span></div>
      </div>
    </header>
    ${failureBanner(payload)}
    <nav class="quick-nav" aria-label="영역 바로가기">${nav}</nav>
    ${highPriority(payload)}
    ${domains.map((domain) => domainSection(domain, payload)).join('')}
    <footer class="footer"><b>PC 로컬 HTML 결과</b> · 생성 ${escapeHtml(generatedLabel(payload.createdAt))} KST · 외부 저장 및 메일 발송 없음</footer>
  </main>
</body>
</html>`;
}

export { escapeHtml };
