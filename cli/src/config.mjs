const PRODUCT_SCOPE = [
  '스마트폰, 태블릿, 스마트워치, 이어폰, TV, 모니터, 사운드바',
  '냉장고, 세탁기, 에어컨, 오븐, 청소기, 식기세척기',
  '의료기기, 네트워크 장비, 전자제품 부품, 반도체, AI 관련 품목',
  '철강, 알루미늄, 플라스틱 등 전자·가전 관련 자재',
].join(', ');

const COMMON_RULES = `
[공통 정확성 규칙]
- 반드시 Gemini CLI의 내장 Google 웹 검색을 사용해 최신 정보를 확인한다.
- 정부·국제기구의 원문, 관보, 신뢰도 높은 주요 언론만 사용한다.
- 발표일은 시행일이나 재게시일이 아니라 해당 조치가 최초 공표된 날짜다.
- 발표일 또는 원문을 확인할 수 없으면 포함하지 않는다. URL을 추측하지 않는다.
- 루머, 전망, 단순 의견, SNS, 동일 사안의 중복 보도를 제외한다.
- 농수산물(HS 01~24)은 제외하되 전 산업에 구조적 영향이 큰 사안은 허용한다.
- 기업 영향은 사실에서 직접 도출되는 범위만 쓰고 과장하지 않는다.
- 우선 품목: ${PRODUCT_SCOPE}
`;

const ITEM_SCHEMA = `{
  "importance": "상|중|하",
  "importanceReason": "중요도 판단 근거 1문장",
  "measureType": "관세율|HS|FTA/원산지|통관|수출통제|제재|AD|SG|CVD 등 조치 유형",
  "title": "간결한 한국어 제목",
  "titleEn": "영문 제목 또는 검색어",
  "summary": "핵심 조치·수치·일정을 담은 한국어 2~3문장",
  "businessImpact": "전자·가전·부품 기업 관점의 영향 1문장, 없으면 빈 문자열",
  "announcedDate": "YYYY-MM-DD",
  "effectiveDate": "YYYY-MM-DD 또는 빈 문자열",
  "hsCode": "관련 HS 코드 또는 빈 문자열",
  "issuingCountry": "발표 주체 국가 또는 기구",
  "targetCountries": "대상·영향 국가",
  "agency": "발표 기관",
  "sourceName": "원문 기관 또는 매체명",
  "sourceUrl": "확인한 HTTPS 원문 URL 또는 빈 문자열",
  "notes": "적용 범위 등 확실한 추가 정보 또는 빈 문자열"
}`;

const customsUnits = [
  ['북미', '미국, 캐나다'],
  ['중남미', '멕시코, 브라질, 콜롬비아, 페루, 아르헨티나, 칠레, 파나마'],
  ['인도', '인도'],
  ['유럽', '영국, EU 및 회원국'],
  ['중동', '이집트, 사우디아라비아, UAE, 모로코, 튀니지, 요르단, 알제리, 튀르키예, 파키스탄, 이스라엘, 이라크'],
  ['동남아', '인도네시아, 말레이시아, 태국, 베트남, 호주, 필리핀, 뉴질랜드, 싱가포르'],
  ['아프리카', '남아프리카공화국, 나이지리아, 케냐'],
  ['CIS', '러시아, 카자흐스탄, 우즈베키스탄'],
  ['중국', '중국'],
];

const exportUnits = [
  ['미국', 'BIS, OFAC, DDTC, 백악관, DOJ'],
  ['한국', '산업통상부, 무역안보관리원, 관세청, 한국무역협회(KITA), 국가정보원 등'],
  ['EU/일본', 'European Commission, Council of the EU, 일본 METI'],
  ['중국/베트남', '중국 MOFCOM·국무원·MIIT·해관, 베트남 산업무역부·세관'],
  ['UN 및 다자체제', 'UN 안보리, Wassenaar, NSG, MTCR, Australia Group'],
];

const tradeUnits = [
  ['반덤핑', 'Anti-Dumping 조사 개시·예비/최종 판정·재심·종료'],
  ['세이프가드', 'Safeguard 조사·잠정/최종 조치·연장·종료'],
  ['보조금/상계관세', 'Subsidies 및 Countervailing Duties 조사·판정·재심'],
];

function units(rows) {
  return rows.map(([key, description]) => ({ key, label: key, description }));
}

export const domains = [
  {
    key: 'customs',
    label: '관세',
    color: '#2563eb',
    softColor: '#eff6ff',
    units: units(customsUnits),
    scope: `
[관세 영역]
- 포함: 일반 관세율, HS 분류, FTA·원산지, 과세가격, 통관절차, 일반 수입 인허가·기술인증·검역.
- 제외: 반덤핑·세이프가드·상계관세는 무역구제 영역, 전략물자·제재·EAR·Entity List는 수출통제 영역.
- 중요도 상: 법령 개정, 즉시 적용 또는 광범위한 비용·통관 영향. 중: 준비·모니터링 필요. 하: 참고 동향.
`,
  },
  {
    key: 'export',
    label: '수출통제',
    color: '#dc2626',
    softColor: '#fef2f2',
    units: units(exportUnits),
    scope: `
[수출통제 영역]
- 포함: 전략물자·이중용도 통제, 경제제재, Entity List·SDN, EAR·ITAR, 수출허가·캐치올, 다자 수출통제체제.
- 제외: 일반 관세·HS·FTA·통관은 관세 영역, AD·SG·CVD는 무역구제 영역.
- 특히 한국 기업 직접 거명, 반도체·AI 통제, 중국 핵심광물, 한국 법령 개정을 우선한다.
- 중요도 상: 한국 기업·공급망에 즉각적이고 직접적인 영향. 중: 준수 준비 필요. 하: 참고 동향.
`,
  },
  {
    key: 'trade',
    label: '무역구제',
    color: '#15803d',
    softColor: '#f0fdf4',
    units: units(tradeUnits),
    scope: `
[무역구제 영역]
- 포함: 반덤핑(AD), 세이프가드(SG), 보조금·상계관세(CVD)의 조사 개시, 예비·최종 판정, 관세 부과, 재심, 연장·종료.
- 제외: 일반 관세·HS·FTA·통관은 관세 영역, 전략물자·제재·수출허가는 수출통제 영역.
- 중요도 상: 실제 관세율·적용 품목·대상 기업에 직접 변화. 중: 조사·재심 등 대응 필요. 하: 참고 동향.
`,
  },
];

export const unitCount = domains.reduce((sum, domain) => sum + domain.units.length, 0);

export function buildDomainPrompt(domain, context) {
  const categoryTemplate = domain.units
    .map((unit) => `    "${unit.key}": [${ITEM_SCHEMA}]`)
    .join(',\n');
  const categoryScope = domain.units
    .map((unit) => `- ${unit.key}: ${unit.description}`)
    .join('\n');

  return [
    '당신은 기업용 글로벌 통상 리서치 애널리스트다.',
    '파일을 읽거나 수정하지 말고 셸 명령도 실행하지 않는다. 웹 조사만 수행한다.',
    `조사 기간(KST): ${context.fromStr} ~ ${context.toStr}`,
    `오늘(KST): ${context.toISO}`,
    '',
    `[조사 영역] ${domain.label}`,
    categoryScope,
    domain.scope.trim(),
    COMMON_RULES.trim(),
    '',
    '[수집 수량]',
    '- 각 카테고리별 최대 5건. 해당 기간에 검증된 신규 동향이 없으면 빈 배열을 둔다.',
    '- 모든 카테고리 키를 반드시 한 번씩 포함한다.',
    '',
    '[출력 형식]',
    '- 설명, 마크다운, 코드 펜스 없이 아래 형태의 JSON 객체 하나만 출력한다.',
    '- insight는 전체 영역의 핵심 흐름과 기업 대응 포인트를 한국어 2~3문장으로 작성한다. 항목이 모두 없으면 빈 문자열이다.',
    '{',
    `  "domain": "${domain.key}",`,
    '  "insight": "영역 종합 인사이트",',
    '  "categories": {',
    categoryTemplate,
    '  }',
    '}',
  ].join('\n');
}

export function domainByKey(key) {
  return domains.find((domain) => domain.key === key) || null;
}
