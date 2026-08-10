# 프로젝트 작업 지침

이 저장소는 회사 Claude Code CLI를 이용해 통상 동향을 조사하고 PC 로컬 HTML 한 파일을
생성하는 수동 실행 도구입니다.

- 런타임은 순수 Node.js ES modules이며 Apps Script 코드를 추가하지 않습니다.
- 메일, SMTP, Gmail, Google Drive, Sheets, Obsidian, 예약·시간 트리거를 추가하지 않습니다.
- 별도 API 키를 요구하거나 저장하지 않고 현재 회사 Claude Code CLI 인증을 사용합니다.
- 회사 IT가 제공한 경우 `CLAUDE_CLI_REQUIRE_ABSOLUTE_BIN`과
  `CLAUDE_CLI_ALLOWED_SHA256`로 실행 파일 절대경로·해시를 고정할 수 있으며, 불일치는
  보안 오류로 중단합니다. SHA-256 고정은 실제 payload인 네이티브 `.exe`·`.com`에만
  허용하고 `.cmd`·`.bat` 래퍼에는 적용하지 않습니다.
- `cli/.env`에서 읽을 수 있는 키는 실행기에 필요한 명시적 allowlist로 제한하며,
  Claude Code 인증·회사 관리 설정을 저장소 설정으로 주입하지 않습니다.
- 조사 영역과 프롬프트의 기준은 `cli/src/config.mjs`입니다.
- 전체 조사 산출물은 `cli/output/monitoring.html`, 그룹 산출물은 영역별
  `monitoring-customs.html`·`monitoring-export.html`·`monitoring-trade.html`입니다.
- 단일 카테고리 산출물은 `monitoring-{domain}-{safe-unit}.html`로 분리하고, 사용자가
  `--out`으로 명시한 경로는 그 지시를 우선합니다.
- 일부 카테고리만 완료한 실행은 대표 HTML을 기본적으로 덮지 않고 timestamp가 붙은
  `.partial-*.html`에 저장하며 종료 코드 2를 사용합니다. 대표 파일 교체는 사용자가
  `--allow-partial-overwrite`를 명시한 경우에만 허용합니다.
- HTML은 외부 CSS, JavaScript, 이미지 없이 자체 포함 형태로 렌더링합니다.
- 모델 텍스트는 반드시 HTML escape하고 출처는 공개 HTTPS URL 형식만 허용합니다.
- HTML은 '검색 후 0건', '수집 실패로 확인 불가', '구버전 상태 정보 없음'을
  서로 다르게 표시해야 합니다.
- HTML 제목과 내용은 전체·그룹·단일 카테고리 범위를 명시하고, 완료 카테고리·완전 완료
  영역 및 검증 제외·표시 한도 제외·중복 제거 건수를 표시해야 합니다.
- 목 출력은 브라우저 제목과 본문 모두에서 `MOCK · 테스트 전용`임을 명확히 표시합니다.
- 보조 텍스트도 WCAG AA 명암 대비를 지키고 키보드 포커스를 남색·금색 이중 표시로
  드러냅니다. 카테고리 바로가기, 맨 위로 링크와 인쇄용 원문 URL을 유지합니다.
- 모든 결과에 'AI 예비 조사·원문 수동 확인 필수'를 표시하고, 출처명·실제 hostname·
  `sourceVerification`을 함께 보여줍니다. HTTPS 형식 검사를 원문 검증으로 표현하지 않습니다.
- 외부 원문 URL을 Node에서 직접 fetch하거나 DNS 조회하지 않습니다.
- Claude Code는 비어 있는 OS 임시 폴더에서 `--safe-mode`로 실행하고,
  `--tools WebSearch`, `--permission-mode dontAsk`, 엄격한 MCP 차단 인수로
  파일·셸·WebFetch·사용자 정의 도구를 사용할 수 없게 합니다.
- 회사 hardening이 요청한 `dontAsk`를 `default`로 강제하는 경우도
  `--allowedTools WebSearch`, 정확한 init 도구 목록, 권한 거부 없음과 실제 도구 이벤트를
  모두 검증한 때에만 허용합니다. 다른 권한 모드는 거부합니다.
- 전체 18개, 그룹 9개·6개·3개, 단일 카테고리 1개를 각각 별도의 Claude 호출로
  조사합니다. 기본은 전역 조사 잠금과 동시성 1이며, 사용자가 위험을 이해하고
  `--allow-parallel`을 명시한 경우만 전역 잠금을 우회합니다.
- 각 카테고리는 `cli/src/config.mjs`에 비어 있지 않은 신뢰 공식 도메인 목록을 둡니다.
  `fast`·`standard`·`deep` 조사 깊이와 카테고리의 국가·기관 등 하위 대상 수에 따라
  공식기관 및 일반 검색의 최소 횟수와 최대 항목 수를 계산합니다.
- stream-json 기록에서 서로 다른 검색어, 공식 검색 요청의 `allowed_domains`, 공식 검색
  결과 URL 호스트, 도메인 제한 없는 일반 동향 검색과 성공 결과를 함께 검증합니다.
  필수 횟수를 채운 뒤의 추가 검색 실패는 경고로 보존합니다. 목록 밖 도메인과 응답·검색
  검증 오류는 첫 실패 원인을 포함한 보정 프롬프트로 해당 카테고리를 한 번만 재조사합니다.
- 중복 제거와 표시 한도 적용으로 제외된 건수는 카테고리 상태와 전체 감사 통계에 남깁니다.
- `--lookback`을 생략하면 동일 scope·depth의 마지막 완전 성공 시각에서 6시간을 겹쳐
  조사하되 최대 168시간까지만 소급합니다. 기록이 없을 때만 요일 기본값을 사용합니다.
- `CLAUDE_RUN_TIMEOUT_MS`가 없으면 전체 실행 제한은 fast 60분, standard 120분,
  deep 240분입니다. 사용자가 환경변수로 지정하면 그 값을 우선합니다.
- 보안 정책이나 사전 점검을 우회하는 fallback을 추가하지 않습니다.
- Windows 동시 실행 잠금은 전역 조사 잠금과 결과 경로별 named pipe를 실제 잠금으로
  사용하고, 파일은 진단 정보로만 사용합니다. 사용자에게 잠금 파일 수동 삭제를 지시하지
  않습니다.
- UNC 네트워크 공유 출력은 기본 차단하고 `--allow-network-output`을 명시한 경우만
  허용합니다.
- 변경 후 저장소 루트에서 `npm --prefix .\cli test`와 mock 실행을 확인합니다.
- GitHub Actions는 Windows와 지원 Node 20·22·24에서 테스트와 mock HTML 생성을
  확인해야 합니다.
- `.env`와 `cli/output/`은 읽거나 커밋하지 않습니다.
