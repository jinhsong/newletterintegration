// ============================================================
// 글로벌 통상 통합 모니터링 시스템 (관세 + 수출통제 + 무역구제)
// Google Apps Script | Gemini API + Google Search Grounding
//
// 기존에 3개로 분리되어 각각 메일을 보내던 시스템을
//   1) 관세 동향
//   2) 수출통제 동향
//   3) 무역구제 동향
// 을 하나의 파이프라인으로 통합하여 "단 한 통"의 메일로 발송한다.
//
// [핵심 설계]
//  - 3개 영역(도메인)을 DOMAINS 배열로 선언. 각 도메인은 카테고리(unit)별
//    프롬프트/정규화/색상/DB 스키마를 갖는다.
//  - 모든 도메인·카테고리의 Gemini 검색 요청을 한 번의 fetchAll 로 병렬 발사
//    → 17개(9+5+3) 요청이 동시에 처리되어 전체 시간 = 가장 느린 1건.
//  - 수집된 모든 항목을 공통 스키마(normalize)로 변환 → 출처 URL 확보,
//    중복 제거, 인사이트, 렌더링을 단일 엔진으로 처리.
//  - 이메일은 도메인 3개 섹션을 가진 단일 HTML 로 1회 발송.
//
// [초기 설정 순서]
//  1. 프로젝트 설정 > 스크립트 속성
//       GEMINI_API_KEY      (필수)
//       ADMIN_EMAIL         (선택, 오류 알림 수신)
//       OBSIDIAN_FOLDER_ID  (선택, 옵시디안 저장)
//  2. initializeSheets()        실행 → 시트 생성
//  3. 발송인 명단 시트에 수신자 입력 (A:이름 B:이메일 / E열 'Y' 발송여부)
//  4. setupTriggers()           실행 → 평일 09시 정기 + 5분 요청 폴링 등록
//  5. runMonitoringNow()        실행 → 즉시 테스트 발송
// ============================================================

// ── 공통 모델/엔드포인트 ─────────────────────────────────
var GEMINI_MODEL = 'gemini-2.5-pro';
var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ── 재시도 ───────────────────────────────────────────────
var RETRY_MAX = 4;            // 최대 재시도 라운드
var RETRY_BASE_MS = 8000;     // 8s → 16s → 32s → 64s

// ── 실행 시간 예산 (Apps Script 6분 제한 대응) ───────────
var TOTAL_TIME_BUDGET_MS = 330000; // 전체 소프트 데드라인 (5.5분)
var FINISH_RESERVE_MS = 70000;     // 저장 + HTML 빌드 + 발송 예약
var RETRY_TIME_BUDGET_MS = 180000; // 수집(재시도 포함) 최대 경과
var SOURCE_STAGE_MIN_MS = 25000;   // 출처 단계 1개 시작 최소 잔여
var SOURCE_BATCH_SIZE = 20;        // 출처 검증/RSS fetchAll 배치

// ── 잠금 ─────────────────────────────────────────────────
var LOCK_WAIT_DAILY_MS = 180000;   // 정기 실행 잠금 대기 (3분)
var LOCK_WAIT_REQUEST_MS = 5000;   // 요청 폴링 잠금 대기 (5초)

// ── 중복 제거 ────────────────────────────────────────────
var DEDUPE_LOOKBACK_DAYS = 7;      // 도메인 DB 소급 비교 일수
var DEDUPE_SIMILARITY = 0.7;       // bigram Dice 유사도 임계값
var DEDUPE_HISTORY_MAX_ROWS = 1500;

// ── 원문 URL 확보 ────────────────────────────────────────
var RESOLVE_BATCH_SIZE = 30;       // fetchAll 1회당 리다이렉트 해소 수
var SOURCES_PER_ITEM = 2;          // 항목당 보존 출처 수
var URL_VALIDATE_MAX = 40;         // 모델 제공 URL 검증 최대 건수
var NEWS_SEARCH_MAX = 40;          // 뉴스 RSS 검색 최대 건수
var NEWS_MATCH_THRESHOLD = 0.5;    // RSS 채택 최소 점수

// ── 발송 ─────────────────────────────────────────────────
var BCC_BATCH_SIZE = 45;           // 메일 1통당 BCC 인원

// ── 옵시디안 ─────────────────────────────────────────────
var OBSIDIAN_FOLDER_ID_PROP = 'OBSIDIAN_FOLDER_ID';
var OBSIDIAN_FOLDER = '통상동향';   // 폴더 ID 미지정 시 사용할 폴더명

// ── 이메일 요청 (온디맨드) ───────────────────────────────
var REQUEST_KEYWORD = '통상 요청';            // 제목에 포함되면 처리
var PROCESSED_LABEL = 'trade-monitor-done';   // 처리완료 라벨(영문 권장)
var REQUEST_SEARCH_WINDOW_H = 25;             // 최근 N시간 메일만 감지
var ONDEMAND_DAILY_LIMIT = 5;                 // 요청자 1인당 일일 한도

// ── 시트 이름 ────────────────────────────────────────────
var SHEET_RECIPIENTS = '발송인 명단';
var SHEET_LOG = '발송로그';
var LOG_HEADERS = ['발송일시(KST)', '유형', '수신자수', '관세', '수출통제', '무역구제', '상건수', '비고'];

// ── 중요도 ───────────────────────────────────────────────
var IMPORTANCE_ORDER = { '상': 0, '중': 1, '하': 2 };
var IMPORTANCE_COLORS = { '상': '#c62828', '중': '#ef6c00', '하': '#2e7d32' };
var IMPORTANCE_BG = { '상': '#fdecea', '중': '#fff3e0', '하': '#e8f5e9' };

var FONT_STACK = "'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',Arial,sans-serif";


// ============================================================
//  도메인 정의
//  각 도메인 = { key, label, accent, dbSheet, obsidianTitle,
//               units:[{key,label,desc,color}], buildPrompt, normalize,
//               dbHeader, dbRow }
//  - units 순서대로 이메일/시트에 렌더링
//  - buildPrompt(unit, ctx): ctx={fromStr,toStr,fromISO,toISO,now,fromDate}
//  - normalize(raw): 원시 JSON 객체 → 공통 항목 스키마
// ============================================================

// 공통 항목 스키마 (normalize 결과):
//   { gubun, importance, title, titleEn, summary, announcedDate,
//     effectiveDate, hsCode, issuingCountry, targetCountries, agency,
//     sourceName, importanceReason, notes, __modelUrl }
// 파이프라인이 추가: __sourceUris, sourceUrl, sourceDomain, sourceUrl2,
//                    sourceDomain2, __urlSource

function _imp(v) { return (v === '상' || v === '중' || v === '하') ? v : '하'; }
function _str(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function _modelUrl(v) { var u = _str(v); return /^https?:\/\//i.test(u) ? u : ''; }

// ────────────────────────────────────────────────────────
//  도메인 1: 관세
// ────────────────────────────────────────────────────────
var CUSTOMS_CATEGORIES = {
  '북미': ['미국', '캐나다'],
  '중남미': ['멕시코', '브라질', '콜롬비아', '페루', '아르헨티나', '칠레', '파나마'],
  '인도': ['인도'],
  '유럽': ['영국', 'EU 회원국'],
  '중동': ['이집트', '사우디아라비아', 'UAE', '모로코', '튀니지', '요르단', '알제리', '튀르키예', '파키스탄', '이스라엘', '이라크'],
  '동남아': ['인도네시아', '말레이시아', '태국', '베트남', '호주', '필리핀', '뉴질랜드', '싱가폴'],
  '아프리카': ['남아프리카공화국', '나이지리아', '케냐'],
  'CIS': ['러시아', '카자흐스탄', '우즈베키스탄'],
  '중국': ['중국']
};
var CUSTOMS_COLORS = {
  '북미': '#1a3c5e', '중남미': '#1b5e3b', '인도': '#7b3000',
  '유럽': '#003080', '중동': '#6d3b00', '동남아': '#00565a',
  '아프리카': '#4a2800', 'CIS': '#3a1a5a', '중국': '#990000'
};
var GUBUN_COLORS = {
  '관세율': '#1a3c5e', 'HS': '#1b5e3b', 'FTA/원산지': '#6d3b00',
  '과세가격': '#4a2800', '수출입규제': '#7b3000', '통관 일반': '#003080'
};

var DOMAIN_CUSTOMS = {
  key: 'customs',
  label: '관세',
  accent: '#14294a',
  dbSheet: '관세_동향DB',
  obsidianTitle: '글로벌 관세 동향',
  units: Object.keys(CUSTOMS_CATEGORIES).map(function(k) {
    return { key: k, label: k, desc: CUSTOMS_CATEGORIES[k].join(', '), color: CUSTOMS_COLORS[k] };
  }),
  dbHeader: ['수집일시', '카테고리', '구분', '제목', '주요내용', '발표일', '발표국가', '영향국가', '관련기관', '출처명', '중요도', '중요도근거', '출처URL', '시행일', 'HS코드'],
  dbRow: function(it, unitLabel, dateStr) {
    return [dateStr, unitLabel, it.gubun, it.title, it.summary, it.announcedDate,
      it.issuingCountry, it.targetCountries, it.agency, it.sourceName, it.importance,
      it.importanceReason, it.sourceUrl || '', it.effectiveDate, it.hsCode];
  },
  normalize: function(raw) {
    return {
      gubun: _str(raw['구분']),
      importance: _imp(raw['중요도']),
      title: _str(raw['제목']),
      titleEn: _str(raw['제목EN']),
      summary: _str(raw['주요내용']),
      announcedDate: _str(raw['발표일']),
      effectiveDate: _str(raw['시행일']),
      hsCode: _str(raw['HS코드']),
      issuingCountry: _str(raw['발표국가']),
      targetCountries: _str(raw['영향국가']),
      agency: _str(raw['관련기관']),
      sourceName: _str(raw['출처명']),
      importanceReason: _str(raw['중요도근거']),
      notes: '',
      __modelUrl: _modelUrl(raw['출처URL'])
    };
  },
  buildPrompt: function(unit, ctx) {
    var countries = CUSTOMS_CATEGORIES[unit.key];
    return '당신은 글로벌 무역·관세 전문 리서치 애널리스트입니다.\n\n' +
      '[수집 기간] ' + ctx.fromStr + ' ~ ' + ctx.toStr + ' (KST)\n' +
      '[대상 국가 / 카테고리: ' + unit.key + '] ' + countries.join(', ') + '\n\n' +
      '[모니터링 항목]\n' +
      '관세율 변경 / HS code 개정 / 통관절차 변경 / FTA 체결·발효·개정·협상 / ' +
      '관세 감면·유예제도 변경 / 수출입 허가·등록제 도입·변경 / 기술인증·검역 규정 강화\n\n' +
      '[정확성 규칙 - 최우선]\n' +
      '- 정부기관 공식 발표, 관보 게재, 공신력 있는 주요 언론 보도만 포함.\n' +
      '- 루머, 추측성 기사, 발효 전 단순 입법예고, SNS, 교차확인 불가 항목 금지.\n' +
      '- 불확실하면 제외. 동일 사안 중복 금지(가장 공신력 있는 출처 1건 통합).\n\n' +
      '[품목 필터]\n' +
      '- 우선 수집: 스마트폰, 태블릿, 스마트워치, 이어폰, TV, 모니터, 사운드바, ' +
      '냉장고, 세탁기, 에어컨, 오븐, 청소기, 식기세척기, 의료기기, 네트워크 장비, ' +
      '기타 전자제품·부품, 철강/알루미늄/플라스틱 등 관련 자재\n' +
      '- 농수산물 동향은 제외. 단, 무역 전반에 구조적 영향이 큰 이슈는 포함 가능.\n\n' +
      '[날짜 규칙 - 엄수]\n' +
      '- 오늘(KST): ' + ctx.toStr + '. 최신 정보만 필요합니다.\n' +
      '- ' + ctx.fromISO + ' ~ ' + ctx.toISO + ' (KST) 사이에 "최초" 발표·보도된 항목만 포함.\n' +
      '- 발표일 = 사안이 처음 공표/보도된 날(KST). 재보도·요약·후속기사 게시일 금지.\n' +
      '- 발표일 불확실/교차확인 불가 시 항목 제외(추정 금지).\n\n' +
      '[구분 기준]\n' +
      '관세율 | HS | FTA/원산지 | 과세가격 | 수출입규제 | 통관 일반\n\n' +
      '[중요도 기준]\n' +
      '상: 법령 개정·즉각적 영향 | 중: 모니터링 필요 | 하: 참고 동향\n\n' +
      '[출력 규칙]\n' +
      '- 순수 JSON 배열만 출력. 코드블록·설명·이모지 금지. 없으면 [] 반환.\n' +
      '- 형식: [{"구분":"관세율|HS|FTA/원산지|과세가격|수출입규제|통관 일반",' +
      '"제목":"한글 간결 제목","제목EN":"영어 번역",' +
      '"주요내용":"사실 기반 2~3문장, 핵심 수치·품목·시행일 중심",' +
      '"발표일":"YYYY-MM-DD","시행일":"YYYY-MM-DD 또는 빈 문자열",' +
      '"HS코드":"예 8517.13 또는 빈 문자열",' +
      '"발표국가":"발표 기관 국가","영향국가":"영향국(다르면 기재)",' +
      '"관련기관":"정부·유관기관명","출처명":"기관명 또는 언론사명",' +
      '"출처URL":"원문 정확한 전체 URL, 모르면 빈 문자열(추측 금지)",' +
      '"중요도":"상|중|하","중요도근거":"판단 근거 한 문장"}]';
  }
};

// ────────────────────────────────────────────────────────
//  도메인 2: 수출통제
// ────────────────────────────────────────────────────────
var EXPORT_UNITS = [
  { key: 'US', label: '미국', color: '#1a3c5e' },
  { key: 'KR', label: '한국', color: '#1b5e3b' },
  { key: 'EUJP', label: 'EU/일본', color: '#003080' },
  { key: 'CNVN', label: '중국/베트남', color: '#990000' },
  { key: 'UNETC', label: 'UN 및 기타', color: '#3a1a5a' }
];
var EXPORT_ISSUER = {
  US: '## ISSUING COUNTRY: United States\nONLY measures issued by US bodies: BIS (Entity List, EAR), OFAC (SDN, sectoral sanctions), DDTC (ITAR, USML), White House (EO), DOJ.\nPriority: any US action naming a KOREAN company; semiconductor/AI controls.\nEXCLUDE other countries\' reactions.',
  KR: '## ISSUING COUNTRY: Republic of Korea\nONLY measures by Korean bodies: 산업통상부(MOTIE), 무역안보관리원, 무역협회(KITA), 관세청, 국가정보원.\nKey: 대외무역법/시행령, 전략물자수출입고시, 전략물자, 대러 제재, 무역안보, 경제안보.\nEXCLUDE foreign governments.',
  EUJP: '## ISSUING COUNTRY: European Union or Japan\nEU: European Commission, Council of the EU (dual-use regulation, Russia sanctions).\nJapan: METI/経済産業省 (FEFTA, catch-all controls).\nEXCLUDE other countries\' reactions.',
  CNVN: '## ISSUING COUNTRY: China or Vietnam\nChina: MOFCOM (export control/unreliable entity list), State Council (rare earth, critical minerals), MIIT, Customs.\nVietnam: Ministry of Industry and Trade, Customs (Decree 69).\nEXCLUDE other countries\' responses.',
  UNETC: '## ISSUING BODY: United Nations or Multilateral Export Control Regimes\nUN: Security Council resolutions, 1718/1737/2231 Committees, consolidated sanctions list.\nRegimes: Wassenaar (WA), NSG, MTCR, Australia Group (AG).\nEXCLUDE individual countries\' implementations.'
};

var DOMAIN_EXPORT = {
  key: 'export',
  label: '수출통제',
  accent: '#5a1a1a',
  dbSheet: '수출통제_동향DB',
  obsidianTitle: '글로벌 수출통제 동향',
  units: EXPORT_UNITS,
  dbHeader: ['저장일시(KST)', '카테고리', '중요도', '제목', '주요내용', '발표일', '발표국가', '대상국가', '관련기관', '비고', '원문URL'],
  dbRow: function(it, unitLabel, dateStr) {
    return [dateStr, unitLabel, it.importance, it.title, it.summary, it.announcedDate,
      it.issuingCountry, it.targetCountries, it.agency, it.notes, it.sourceUrl || ''];
  },
  normalize: function(raw) {
    return {
      gubun: '',
      importance: _imp(raw.importance),
      title: _str(raw.title),
      titleEn: _str(raw.search_query),
      summary: _str(raw.summary),
      announcedDate: _str(raw.published_date),
      effectiveDate: '',
      hsCode: '',
      issuingCountry: _str(raw.issuing_country),
      targetCountries: _str(raw.target_countries),
      agency: _str(raw.related_agencies),
      sourceName: _str(raw.source_name),
      importanceReason: '',
      notes: _str(raw.notes),
      __modelUrl: ''
    };
  },
  buildPrompt: function(unit, ctx) {
    var schema =
      '[{"importance":"상|중|하","title":"한국어 제목 40자 이내",' +
      '"summary":"한국어 최대 2문장: 사실+핵심 영향, 배경 금지",' +
      '"published_date":"YYYY-MM-DD (최초 발표/보도일 KST)",' +
      '"issuing_country":"발표 주체(미국|한국|EU|일본|중국|베트남|UN|WA 등)",' +
      '"target_countries":"대상/영향 국가",' +
      '"related_agencies":"BIS|OFAC|DDTC|백악관|산업통상부|무역안보관리원|무역협회|관세청|European Commission|METI|MOFCOM|UN|WA|NSG|MTCR|AG|기타",' +
      '"source_name":"출처 기관/매체 짧은 이름",' +
      '"search_query":"영문 검색 키워드 5-8단어",' +
      '"notes":"확실한 맥락만, 불확실하면 빈 문자열"}]';
    return 'You are an expert analyst of global export control regulations.\n' +
      'Current Korean time: ' + ctx.toStr + ' (KST).\n\n' +
      (EXPORT_ISSUER[unit.key] || '') + '\n\n' +
      '## Recency (CRITICAL): TODAY is ' + ctx.toISO + ' (KST). Include ONLY items whose ORIGINAL ' +
      'publication date is ON OR AFTER ' + ctx.fromISO + ' (KST). published_date = ORIGINAL first ' +
      'publication date (NOT amendment effective date / re-publication / last-updated). ' +
      'If you cannot confirm, EXCLUDE. Never fabricate dates.\n\n' +
      '## Importance: 상=한국 법령 개정·US EAR/반도체·AI controls·China rare earth·한국기업 직접 거명; ' +
      '중=EU/Japan amendments, BIS Entity List, OFAC SDN, ITAR; 하=기타.\n\n' +
      '## Rules: include ONLY items matching the issuing country/body above. Max 8 items, most ' +
      'important first. Merge duplicate coverage. Prefer official primary sources.\n' +
      'Return ONLY a raw JSON array (no markdown fences, no text outside). If none, [].\n\n' +
      'JSON schema:\n' + schema;
  }
};

// ────────────────────────────────────────────────────────
//  도메인 3: 무역구제
// ────────────────────────────────────────────────────────
var TRADE_UNITS = [
  { key: '반덤핑', label: '반덤핑', desc: 'Anti-Dumping (AD)', color: '#990000' },
  { key: '세이프가드', label: '세이프가드', desc: 'Safeguard (SG)', color: '#6d3b00' },
  { key: '보조금/상계관세', label: '보조금/상계관세', desc: 'Subsidies & CVD', color: '#1b5e3b' }
];
var TRADE_ENGCAT = {
  '반덤핑': 'Anti-Dumping (AD)',
  '세이프가드': 'Safeguard (SG)',
  '보조금/상계관세': 'Subsidies & Countervailing Duties (CVD)'
};

var DOMAIN_TRADE = {
  key: 'trade',
  label: '무역구제',
  accent: '#1b4332',
  dbSheet: '무역구제_동향DB',
  obsidianTitle: '글로벌 무역구제 동향',
  units: TRADE_UNITS,
  dbHeader: ['수집일시', '카테고리', '중요도', '제목', '주요내용', '발표일', '대상국가', '관련기관', '비고', '출처명', '출처URL'],
  dbRow: function(it, unitLabel, dateStr) {
    return [dateStr, unitLabel, it.importance, it.title, it.summary, it.announcedDate,
      it.targetCountries, it.agency, it.notes, it.sourceName, it.sourceUrl || ''];
  },
  normalize: function(raw) {
    var tc = Array.isArray(raw.targetCountries) ? raw.targetCountries.map(String).join(', ') : _str(raw.targetCountries);
    return {
      gubun: '',
      importance: _imp(raw.importance),
      title: _str(raw.title),
      titleEn: _str(raw.engTitle),
      summary: _str(raw.summary),
      announcedDate: _str(raw.announcedDate),
      effectiveDate: '',
      hsCode: '',
      issuingCountry: '',
      targetCountries: tc,
      agency: _str(raw.agency),
      sourceName: _str(raw.sourceName),
      importanceReason: '',
      notes: _str(raw.remarks),
      __modelUrl: _modelUrl(raw.sourceUrl)
    };
  },
  buildPrompt: function(unit, ctx) {
    var engCat = TRADE_ENGCAT[unit.key] || unit.key;
    return '당신은 글로벌 무역구제(반덤핑·세이프가드·보조금/상계관세) 전문 분석가입니다.\n' +
      '정부 공식 발표, WTO 문서, 신뢰 매체(Reuters 등)만 참조하십시오. 추정성 내용 금지.\n\n' +
      '조사 기간(KST): ' + ctx.fromStr + ' ~ ' + ctx.toStr + '\n' +
      '★ 위 기간 내 "최초로 게시·공표된" 항목만 수집. 컷오프(' + ctx.fromISO + ') 이전 사안 금지.\n\n' +
      '[과제] "' + unit.key + '(' + engCat + ')" 분야 신규 동향을 수집하여 JSON 배열로만 응답.\n\n' +
      '[PRIORITY] Initiation, Preliminary/Final Determination, Annual/Sunset Review, ' +
      'Tariff Rate Change, Extension/Termination, HS Code\n\n' +
      '[EXCLUSIONS] 농수산물(HS 01–24), 축산·임산·수산물, 무역정책과 무관한 일반 뉴스, 발표일 식별 불가 항목.\n\n' +
      '[중요도] 상: 관세율·HS 등 실제 관세율 변동 직접 영향 | 중: 비즈니스 영향 | 하: 참고 동향.\n\n' +
      '[발표일 정의 엄수] announcedDate = 사안이 세상에 "처음 나온 날"(최초 게시/공표). ' +
      '시행일·재게시·요약기사·후속 인용 기사 날짜 금지. 최초 발표가 컷오프 이전이면 제외. ' +
      '특정 불가 시 항목 제외. 조사 기간(' + ctx.fromISO + ' ~ ' + ctx.toISO + ') 밖 금지.\n\n' +
      '[응답 형식] 마크다운 없이 순수 JSON 배열:\n' +
      '[{"importance":"상|중|하","title":"한국어 제목",' +
      '"engTitle":"English title for Google search",' +
      '"summary":"한국어 2문장 이내: 조치+기업 영향",' +
      '"announcedDate":"YYYY-MM-DD","targetCountries":["국가1","국가2"],' +
      '"agency":"기관명(USTR, MOFCOM 등)","sourceName":"기관명 또는 언론사명",' +
      '"sourceUrl":"원문 정확한 전체 URL, 모르면 빈 문자열(추측 금지)",' +
      '"remarks":"시행일·적용범위·히스토리 등 비고"}]\n' +
      '해당 기간 내 항목 없으면 빈 배열 [] 만 반환.';
  }
};

var DOMAINS = [DOMAIN_CUSTOMS, DOMAIN_EXPORT, DOMAIN_TRADE];

/** key 로 도메인 객체 조회 */
function domainByKey(k) {
  for (var i = 0; i < DOMAINS.length; i++) if (DOMAINS[i].key === k) return DOMAINS[i];
  return null;
}
